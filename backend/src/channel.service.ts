import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { mkdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { createHash } from 'node:crypto';
import { AppStorage } from './app-storage.ts';
import { YtdlpRunner } from './yt-dlp-runner.ts';

export interface VideoInfo {
  id: string;
  title: string;
  thumbnail: string;
  duration: number | null;
  keywords: string[];
  keywordsEnglish: string[];
  keywordsDutch: string[];
}

export interface ChannelBookmark { url: string; title: string; addedAt: string; autoSync: boolean; }
export interface ChannelSuggestion { title: string; url: string; verified: boolean; }
export interface ChannelSuggestionSubsection { title: string; channels: ChannelSuggestion[]; }
export interface ChannelSuggestionSection { title: string; subsections: ChannelSuggestionSubsection[]; }

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

@Injectable()
export class ChannelService {
  private static readonly MAX_ENRICHMENT = 2;

  cookiesBrowser: string = process.env.YTDLP_COOKIES_BROWSER ?? 'chrome';
  private readonly cookiesFile = process.env.YTDLP_COOKIES_FILE;
  private readonly useBrowserCookies = process.env.YTDLP_USE_BROWSER_COOKIES !== 'false';

  private readonly catalogPath: string;
  private readonly channelsPath: string;
  private readonly channelCacheDir: string;
  private readonly suggestionsPath: string;

  private enrichmentActive = 0;
  private readonly channelScans = new Map<string, Promise<VideoInfo[]>>();
  private readonly channelVideoCache = new Map<string, VideoInfo[]>();

  constructor(private readonly storage: AppStorage, private readonly runner: YtdlpRunner) {
    this.catalogPath = join(storage.dataDir, 'videos.json');
    this.channelsPath = join(storage.dataDir, 'channels.json');
    this.channelCacheDir = join(storage.dataDir, 'channel-cache');
    this.suggestionsPath = process.env.SUGGESTIONS_PATH ?? resolve(process.cwd(), '../docs/skills/suggestions.json');
    if (process.env.DEEPL_AUTH_KEY) void this.backfillDutchKeywords();
  }

  get cookieArgs(): string[] {
    if (this.cookiesFile) return ['--cookies', this.cookiesFile];
    if (!this.useBrowserCookies) return [];
    return ['--cookies-from-browser', this.cookiesBrowser];
  }

  updateCookiesBrowser(browser: string) { this.cookiesBrowser = browser; }

  async getChannels(): Promise<ChannelBookmark[]> {
    try {
      const channels = this.storage.readJson<Array<Partial<ChannelBookmark> & Pick<ChannelBookmark, 'url' | 'title' | 'addedAt'>>>(this.channelsPath);
      return channels.map((channel) => ({ ...channel, autoSync: channel.autoSync === true }));
    }
    catch { return []; }
  }

  async getSuggestions(): Promise<ChannelSuggestionSection[]> {
    const data = JSON.parse(await readFile(this.suggestionsPath, 'utf8')) as { sections: ChannelSuggestionSection[] };
    return data.sections;
  }

  async addChannel(channelUrl: string) {
    const parsed = this.parseChannelUrl(channelUrl);
    const url = parsed.href;
    const channels = await this.getChannels();
    if (channels.some((channel) => channel.url === url)) throw new ConflictException('Dit kanaal is al toegevoegd');
    channels.push({ url, title: this.channelTitle(parsed), addedAt: new Date().toISOString(), autoSync: false });
    this.storage.writeJson(this.channelsPath, channels);
    void this.scanChannel(url).catch((error) => console.error(`Kanaalscan mislukt voor ${url}: ${String(error)}`));
    return { channels };
  }

  async setAutoSync(channelUrl: string, enabled: boolean): Promise<ChannelBookmark[]> {
    const channels = await this.getChannels();
    const channel = channels.find((entry) => entry.url === channelUrl);
    if (!channel) throw new NotFoundException('Kanaalbookmark niet gevonden');
    channel.autoSync = enabled;
    this.storage.writeJson(this.channelsPath, channels);
    return channels;
  }

  async removeChannel(channelUrl: string): Promise<ChannelBookmark[]> {
    const channels = (await this.getChannels()).filter((channel) => channel.url !== channelUrl);
    this.storage.writeJson(this.channelsPath, channels);
    return channels;
  }

  async reorderChannels(urls: string[]): Promise<ChannelBookmark[]> {
    const channels = await this.getChannels();
    if (!Array.isArray(urls) || urls.length !== channels.length || new Set(urls).size !== channels.length) {
      throw new BadRequestException('De kanaalvolgorde is ongeldig');
    }
    const byUrl = new Map(channels.map((channel) => [channel.url, channel]));
    const reordered = urls.map((url) => byUrl.get(url));
    if (reordered.some((channel) => !channel)) throw new BadRequestException('De kanaalvolgorde bevat onbekende kanalen');
    const result = reordered as ChannelBookmark[];
    this.storage.writeJson(this.channelsPath, result);
    return result;
  }

  private channelCachePath(url: string) {
    const id = createHash('sha256').update(url).digest('hex');
    return join(this.channelCacheDir, `${id}.json`);
  }

  private async saveChannelCache(url: string, videos: VideoInfo[]) {
    mkdirSync(this.channelCacheDir, { recursive: true });
    this.channelVideoCache.set(url, videos);
    this.storage.writeJson(this.channelCachePath(url), videos);
  }

  async getCachedChannelVideos(url: string): Promise<VideoInfo[] | null> {
    const cached = this.channelVideoCache.get(url);
    if (cached) return cached;
    try {
      const videos = this.storage.readJson<VideoInfo[]>(this.channelCachePath(url));
      this.channelVideoCache.set(url, videos);
      return videos;
    } catch { return null; }
  }

  async scanChannel(url: string): Promise<VideoInfo[]> {
    const existing = this.channelScans.get(url);
    if (existing) return existing;
    const scan = (async () => {
      const videos = await this.listChannel(url);
      await this.saveChannelCache(url, videos);
      return videos;
    })();
    this.channelScans.set(url, scan);
    void scan.then(() => this.channelScans.delete(url), () => this.channelScans.delete(url));
    return scan;
  }

  async listChannel(channelUrl: string): Promise<VideoInfo[]> {
    const u = this.parseChannelUrl(channelUrl);
    const isPlaylist = u.pathname.startsWith('/playlist');
    const hasTab = /\/(videos|streams|shorts)\/?$/.test(u.pathname);
    const target = isPlaylist || hasTab ? u.href : u.href.replace(/\/$/, '') + '/videos';

    const collected: VideoInfo[] = [];
    let batch: VideoInfo[] = [];
    let hadOutput = false;
    let saves = Promise.resolve<void>(undefined);
    const flushBatch = () => {
      if (!batch.length) return;
      const ready = batch;
      batch = [];
      saves = saves.then(() => this.saveVideos(ready).catch(() => undefined));
    };

    const { result } = this.runner.run([
      '--skip-download', '--flat-playlist', '--dump-json', '--no-warnings',
      '--sleep-requests', '2',
      ...this.cookieArgs,
      target,
    ], {
      onLine: (line) => {
        if (!line.trim()) return;
        try {
          const j = JSON.parse(line);
          if (!ID_RE.test(j.id) || this.isMembersOnly(j)) return;
          hadOutput = true;
          const video = this.toVideoInfo(j);
          collected.push(video);
          batch.push(video);
          if (batch.length >= 50) flushBatch();
        } catch { /* Ignore malformed lines and continue. */ }
      },
    });

    const { ok, stderr } = await result;
    if (!ok && !hadOutput) throw new BadRequestException(stderr.trim() || 'yt-dlp is mislukt');
    flushBatch();
    await saves;
    void this.enrichChannelMetadata(target);
    return collected;
  }

  private async enrichChannelMetadata(target: string) {
    if (this.enrichmentActive >= ChannelService.MAX_ENRICHMENT) return;
    this.enrichmentActive++;
    let batch: VideoInfo[] = [];
    let writes = Promise.resolve();
    const saveBatch = (videos: VideoInfo[]) => {
      writes = writes.then(async () => {
        try { await this.saveVideos(await this.withDutchKeywords(videos)); }
        catch { /* Keep the fast import metadata if enrichment or translation fails. */ }
      });
    };
    const { result } = this.runner.run([
      '--skip-download', '--dump-json', '--ignore-errors', '--no-warnings',
      '--sleep-requests', '2',
      ...this.cookieArgs,
      target,
    ], {
      onLine: (line) => {
        if (!line.trim()) return;
        try {
          const info = JSON.parse(line);
          if (this.isMembersOnly(info)) return;
          const video = this.toVideoInfo(info);
          if (!ID_RE.test(video.id)) return;
          batch.push(video);
          if (batch.length >= 40) {
            const ready = batch;
            batch = [];
            saveBatch(ready);
          }
        } catch { /* Ignore malformed metadata lines and continue the scan. */ }
      },
    });
    try {
      await result;
      if (batch.length) saveBatch(batch);
      await writes;
    } finally {
      this.enrichmentActive--;
    }
  }

  private async saveVideos(videos: VideoInfo[]) {
    let catalog: Record<string, VideoInfo> = {};
    try { catalog = this.storage.readJson<Record<string, VideoInfo>>(this.catalogPath); }
    catch { /* First import. */ }
    for (const video of videos) {
      const previous = catalog[video.id];
      catalog[video.id] = {
        ...previous,
        ...video,
        keywordsEnglish: video.keywordsEnglish?.length ? video.keywordsEnglish : previous?.keywordsEnglish ?? video.keywords,
        keywordsDutch: video.keywordsDutch?.length ? video.keywordsDutch : previous?.keywordsDutch ?? [],
        keywords: [...new Set([...(video.keywordsEnglish ?? video.keywords), ...(video.keywordsDutch?.length ? video.keywordsDutch : previous?.keywordsDutch ?? [])])],
      };
    }
    this.storage.writeJson(this.catalogPath, catalog);
  }

  private async withDutchKeywords(videos: VideoInfo[]): Promise<VideoInfo[]> {
    const authKey = process.env.DEEPL_AUTH_KEY;
    if (!authKey) return videos;
    const endpoint = process.env.DEEPL_API_URL ?? 'https://api-free.deepl.com/v2/translate';
    const translated = [...videos];
    for (let start = 0; start < videos.length; start += 40) {
      const batch = videos.slice(start, start + 40);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `DeepL-Auth-Key ${authKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: batch.map((video) => (video.keywordsEnglish ?? video.keywords).join(', ')),
          target_lang: 'NL',
        }),
      });
      if (!response.ok) throw new Error(`DeepL gaf HTTP ${response.status}`);
      const body = await response.json() as { translations?: Array<{ text?: string }> };
      for (const [index, result] of (body.translations ?? []).entries()) {
        const keywordsDutch = [...new Set((result.text ?? '').split(',').map((word) => word.trim().toLocaleLowerCase()).filter(Boolean))];
        const videoIndex = start + index;
        translated[videoIndex] = {
          ...batch[index],
          keywordsDutch,
          keywords: [...new Set([...batch[index].keywordsEnglish, ...keywordsDutch])],
        };
      }
    }
    return translated;
  }

  private async backfillDutchKeywords() {
    try {
      const catalog = this.storage.readJson<Record<string, VideoInfo>>(this.catalogPath);
      const pending = Object.values(catalog).filter((video) => !video.keywordsDutch?.length).map((video) => ({
        ...video,
        keywordsEnglish: video.keywordsEnglish ?? video.keywords ?? [],
        keywordsDutch: video.keywordsDutch ?? [],
      }));
      if (pending.length) await this.saveVideos(await this.withDutchKeywords(pending));
    } catch { /* Keep the collection usable if translation is unavailable. */ }
  }

  private parseChannelUrl(channelUrl: string): URL {
    let parsed: URL;
    try { parsed = new URL(channelUrl); }
    catch { throw new BadRequestException('Ongeldige URL'); }
    if (!/(^|\.)youtube\.com$/.test(parsed.hostname)) throw new BadRequestException('Alleen youtube.com-links zijn toegestaan');
    return parsed;
  }

  private channelTitle(url: URL): string {
    const finalPart = url.pathname.split('/').filter(Boolean).filter((part) => !['videos', 'streams', 'shorts'].includes(part)).at(-1);
    return finalPart ? decodeURIComponent(finalPart) : url.hostname;
  }

  private toVideoInfo(j: any): VideoInfo {
    const title = j.title ?? j.id;
    const sourceTerms = [
      title,
      ...(Array.isArray(j.tags) ? j.tags : []),
      ...(Array.isArray(j.categories) ? j.categories : []),
      j.description ?? '',
    ].join(' ');
    const terms = sourceTerms.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
    return {
      id: j.id,
      title,
      thumbnail: `https://i.ytimg.com/vi/${j.id}/mqdefault.jpg`,
      duration: typeof j.duration === 'number' ? j.duration : null,
      keywords: [...new Set(terms)].slice(0, 100),
      keywordsEnglish: [...new Set(terms)].slice(0, 100),
      keywordsDutch: [],
    };
  }

  private isMembersOnly(info: any): boolean {
    return String(info?.availability ?? '').toLocaleLowerCase() === 'subscriber_only';
  }
}

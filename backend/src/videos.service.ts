import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync } from 'fs';
import { appendFile, readFile, readdir, rename, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';

export interface VideoInfo {
  id: string;
  title: string;
  thumbnail: string;
  duration: number | null;
  keywords: string[];
  keywordsEnglish: string[];
  keywordsDutch: string[];
}

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
// Bestandsnaam: "Titel [videoId].mp4" (zie output-template hieronder)
const FILE_ID_RE = /\[([A-Za-z0-9_-]{11})\]\.[^.]+$/;
export interface ChannelBookmark { url: string; title: string; addedAt: string; autoSync: boolean; }

@Injectable()
export class VideosService implements OnModuleInit {
  private static readonly COOKIE_BROWSERS = ['chrome', 'chromium', 'firefox', 'safari', 'edge', 'brave', 'opera', 'vivaldi', 'whale'] as const;
  private readonly dataDir = join(homedir(), '.youtubedownloader');
  private readonly settingsPath = join(this.dataDir, 'settings.json');
  private readonly catalogPath = join(this.dataDir, 'videos.json');
  private readonly channelsPath = join(this.dataDir, 'channels.json');
  private readonly channelCacheDir = join(this.dataDir, 'channel-cache');
  private readonly queuePath = join(this.dataDir, 'sync-queue.json');
  private readonly subtitleQueuePath = join(this.dataDir, 'subtitle-queue.json');
  private readonly failureLogPath = join(this.dataDir, 'sync-failures.log');
  private configuredDir: string | null = process.env.DOWNLOAD_DIR ? resolve(process.env.DOWNLOAD_DIR) : null;
  private readonly ytdlp = process.env.YTDLP_PATH ?? 'yt-dlp';
  private cookiesBrowser: string = process.env.YTDLP_COOKIES_BROWSER ?? 'chrome';
  private language: 'en' | 'nl' = 'en';

  private queue: string[] = [];
  private subtitleQueue: string[] = [];
  private active = new Map<string, { progress: number }>();
  private activeSubtitleDownloads = new Set<string>();
  private downloadProcesses = new Map<string, ChildProcess>();
  private maxParallelDownloads = 1;
  private syncEnabled = true;
  private pausedIds = new Set<string>();
  private failed = new Set<string>();
  private queueWrite = Promise.resolve();
  private subtitleQueueWrite = Promise.resolve();
  private failureLogWrite = Promise.resolve();
  private channelScans = new Map<string, Promise<VideoInfo[]>>();
  private subtitleDownloads = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  private subtitleAttempts = new Set<string>();
  private channelVideoCache = new Map<string, VideoInfo[]>();

  constructor() {
    mkdirSync(this.dataDir, { recursive: true });
    if (process.env.DEEPL_AUTH_KEY) void this.backfillDutchKeywords();
  }

  async onModuleInit() {
    await this.getSettings();
    try {
      const savedQueue = JSON.parse(await readFile(this.queuePath, 'utf8')) as string[];
      const downloaded = new Set(await this.downloadedIds());
      this.queue = [...new Set(savedQueue.filter((id) => ID_RE.test(id) && !downloaded.has(id)))];
      await this.saveQueue();
    } catch { /* No pending sync work yet. */ }
    try {
      const savedSubtitleQueue = JSON.parse(await readFile(this.subtitleQueuePath, 'utf8')) as string[];
      const downloaded = new Set(await this.downloadedIds());
      this.subtitleQueue = [...new Set(savedSubtitleQueue.filter((id) => ID_RE.test(id) && downloaded.has(id)))];
      await this.saveSubtitleQueue();
    } catch { /* Subtitle work is queued after a video has completed. */ }
    if (this.configuredDir) {
      await this.prioritizeQueue();
      this.pump();
      this.pumpSubtitleQueue();
      void this.scanBookmarkedChannelsOnStartup();
    }
  }

  private async scanBookmarkedChannelsOnStartup() {
    if (!this.configuredDir) return;
    for (const channel of await this.getChannels()) {
      if (!channel.autoSync) continue;
      try {
        await this.scanChannel(channel.url, true);
      } catch (error) {
        console.error(`Kanaalscan mislukt voor ${channel.url}: ${String(error)}`);
      }
    }
  }

  async getSettings() {
    try {
      const saved = JSON.parse(await readFile(this.settingsPath, 'utf8')) as {
        downloadDir?: string; maxParallelDownloads?: number; cookiesBrowser?: string; syncEnabled?: boolean; language?: string;
      };
      if (!this.configuredDir && saved.downloadDir) this.configuredDir = resolve(saved.downloadDir);
      if (Number.isInteger(saved.maxParallelDownloads) && saved.maxParallelDownloads! >= 1) {
        this.maxParallelDownloads = Math.min(saved.maxParallelDownloads!, 8);
      }
      if (saved.cookiesBrowser && VideosService.COOKIE_BROWSERS.includes(saved.cookiesBrowser as typeof VideosService.COOKIE_BROWSERS[number])) this.cookiesBrowser = saved.cookiesBrowser;
      if (typeof saved.syncEnabled === 'boolean') this.syncEnabled = saved.syncEnabled;
      if (saved.language === 'en' || saved.language === 'nl') this.language = saved.language;
    } catch { /* First run: ask the user to choose settings. */ }
    return {
      downloadDir: this.configuredDir,
      maxParallelDownloads: this.maxParallelDownloads,
      cookiesBrowser: this.cookiesBrowser,
      syncEnabled: this.syncEnabled,
      language: this.language,
    };
  }

  private settingsData(downloadDir: string | null) {
    return {
      downloadDir,
      maxParallelDownloads: this.maxParallelDownloads,
      cookiesBrowser: this.cookiesBrowser,
      syncEnabled: this.syncEnabled,
      language: this.language,
    };
  }

  async setLanguage(language: string) {
    if (language !== 'en' && language !== 'nl') throw new BadRequestException('Choose English or Nederlands');
    this.language = language;
    await this.persist(this.settingsPath, this.settingsData(this.configuredDir));
    return this.getSettings();
  }

  async setCookiesBrowser(browser: string) {
    if (!VideosService.COOKIE_BROWSERS.includes(browser as typeof VideosService.COOKIE_BROWSERS[number])) {
      throw new BadRequestException('Kies een ondersteunde browser');
    }
    this.cookiesBrowser = browser;
    await this.persist(this.settingsPath, this.settingsData(this.configuredDir));
    return this.getSettings();
  }

  private get cookieArgs() {
    return ['--cookies-from-browser', this.cookiesBrowser];
  }

  async setSyncEnabled(enabled: boolean) {
    this.syncEnabled = enabled;
    if (!enabled) {
      for (const id of this.active.keys()) {
        this.pausedIds.add(id);
        if (!this.queue.includes(id)) this.queue.unshift(id);
      }
      await this.prioritizeQueue();
      await this.saveQueue();
    }
    await this.persist(this.settingsPath, this.settingsData(this.configuredDir));
    if (!enabled) {
      for (const id of this.active.keys()) this.downloadProcesses.get(id)?.kill('SIGTERM');
    } else {
      await this.prioritizeQueue();
      this.pump();
    }
    return { enabled: this.syncEnabled, state: await this.getState() };
  }

  async setDownloadDir(path: string) {
    const dir = resolve(path.trim());
    if (!path.trim()) throw new BadRequestException('Kies een geldige maplocatie');
    try { mkdirSync(dir, { recursive: true }); }
    catch { throw new BadRequestException('De map kan niet worden aangemaakt'); }
    this.configuredDir = dir;
    await this.persist(this.settingsPath, this.settingsData(dir));
    void this.prioritizeQueue().then(() => this.pump());
    return this.getSettings();
  }

  async setMaxParallelDownloads(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 8) {
      throw new BadRequestException('Gelijktijdige processen moet tussen 1 en 8 liggen');
    }
    this.maxParallelDownloads = value;
    await this.persist(this.settingsPath, this.settingsData(this.configuredDir));
    this.pump();
    return this.getSettings();
  }

  async getChannels(): Promise<ChannelBookmark[]> {
    try {
      const channels = JSON.parse(await readFile(this.channelsPath, 'utf8')) as Array<Partial<ChannelBookmark> & Pick<ChannelBookmark, 'url' | 'title' | 'addedAt'>>;
      return channels.map((channel) => ({ ...channel, autoSync: channel.autoSync === true }));
    }
    catch { return []; }
  }

  async addChannel(channelUrl: string) {
    const parsed = this.parseChannelUrl(channelUrl);
    const url = parsed.href;
    const channels = await this.getChannels();
    if (channels.some((channel) => channel.url === url)) throw new ConflictException('Dit kanaal is al toegevoegd');
    channels.push({ url, title: this.channelTitle(parsed), addedAt: new Date().toISOString(), autoSync: false });
    await this.persist(this.channelsPath, channels);
    void this.scanChannel(url, false).catch((error) => console.error(`Kanaalscan mislukt voor ${url}: ${String(error)}`));
    return { channels };
  }

  async setChannelAutoSync(channelUrl: string, enabled: boolean) {
    const channels = await this.getChannels();
    const channel = channels.find((entry) => entry.url === channelUrl);
    if (!channel) throw new NotFoundException('Kanaalbookmark niet gevonden');
    channel.autoSync = enabled;
    await this.persist(this.channelsPath, channels);
    if (!enabled) return { channels, scanned: 0, queued: 0 };
    const videos = await this.scanChannel(channelUrl, true);
    const state = await this.getState();
    return { channels: await this.getChannels(), scanned: videos.length, queued: state.queued.length };
  }

  private channelCachePath(url: string) {
    const id = createHash('sha256').update(url).digest('hex');
    return join(this.channelCacheDir, `${id}.json`);
  }

  private async saveChannelCache(url: string, videos: VideoInfo[]) {
    mkdirSync(this.channelCacheDir, { recursive: true });
    this.channelVideoCache.set(url, videos);
    await this.persist(this.channelCachePath(url), videos);
  }

  private async scanChannel(url: string, enqueueVideos: boolean) {
    const existing = this.channelScans.get(url);
    let scan = existing;
    if (!scan) {
      scan = (async () => {
      const videos = await this.listChannel(url);
      await this.saveChannelCache(url, videos);
      return videos;
      })();
      this.channelScans.set(url, scan);
      void scan.then(() => this.channelScans.delete(url), () => this.channelScans.delete(url));
    }
    const videos = await scan;
    if (enqueueVideos) await this.enqueue(videos.map((video) => video.id));
    return videos;
  }

  async getChannelVideoPage(url: string, offset = 0, limit = 20) {
    const bookmark = (await this.getChannels()).find((channel) => channel.url === url);
    if (!bookmark) throw new NotFoundException('Kanaalbookmark niet gevonden');
    const videos = await this.getCachedChannelVideos(url);
    if (!videos) {
      void this.scanChannel(url, bookmark.autoSync).catch((error) => console.error(`Kanaalscan mislukt voor ${url}: ${String(error)}`));
      return { items: [], total: 0, offset, hasMore: false, scanning: true };
    }
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    return {
      items: videos.slice(safeOffset, safeOffset + safeLimit),
      total: videos.length,
      offset: safeOffset,
      hasMore: safeOffset + safeLimit < videos.length,
      scanning: false,
    };
  }

  private async getCachedChannelVideos(url: string): Promise<VideoInfo[] | null> {
    const cached = this.channelVideoCache.get(url);
    if (cached) return cached;
    try {
      const videos = JSON.parse(await readFile(this.channelCachePath(url), 'utf8')) as VideoInfo[];
      this.channelVideoCache.set(url, videos);
      return videos;
    } catch { return null; }
  }

  async getChannelProgress() {
    const channels = await this.getChannels();
    const downloaded = new Set(await this.downloadedIds());
    const queued = new Set(this.queue);
    const active = new Map(this.active);
    const results = [];
    for (const channel of channels) {
      const videos = await this.getCachedChannelVideos(channel.url);
      const activeItems: Array<VideoInfo & { progress: number }> = [];
      const queuedItems: VideoInfo[] = [];
      const failedItems: VideoInfo[] = [];
      let completed = 0;
      let overallProgress = 0;
      for (const video of videos ?? []) {
        if (downloaded.has(video.id)) {
          completed++;
          overallProgress += 1;
        } else if (active.has(video.id)) {
          const progress = active.get(video.id)!.progress;
          activeItems.push({ ...video, progress });
          overallProgress += progress / 100;
        } else if (queued.has(video.id)) queuedItems.push(video);
        else if (this.failed.has(video.id)) failedItems.push(video);
      }
      const total = videos?.length ?? 0;
      results.push({
        ...channel,
        total,
        completed,
        active: activeItems,
        queued: queuedItems,
        failed: failedItems,
        percent: total ? Math.floor((overallProgress / total) * 100) : 0,
        scanning: !videos,
      });
    }
    return results;
  }

  async getFailureLog(limit = 1000) {
    const safeLimit = Math.min(1000, Math.max(1, Math.floor(limit)));
    try {
      const lines = (await readFile(this.failureLogPath, 'utf8')).split(/\r?\n/).filter(Boolean);
      return { lines: lines.slice(-safeLimit), totalLines: lines.length };
    } catch { return { lines: [], totalLines: 0 }; }
  }

  private async recordFailure(id: string, details: string) {
    let title = id;
    try {
      const catalog = JSON.parse(await readFile(this.catalogPath, 'utf8')) as Record<string, VideoInfo>;
      title = catalog[id]?.title ?? id;
    } catch { /* The video ID still identifies the failed item. */ }
    const detailLines = details.split(/\r?\n/).filter(Boolean).slice(-80);
    const entry = [
      `[${new Date().toISOString()}] FAILED ${title} [${id}]`,
      ...(detailLines.length ? detailLines : ['yt-dlp stopped without reporting a reason.']),
      '',
    ].join('\n');
    this.failureLogWrite = this.failureLogWrite.catch(() => undefined).then(async () => {
      await appendFile(this.failureLogPath, entry, 'utf8');
      const lines = (await readFile(this.failureLogPath, 'utf8')).split(/\r?\n/).filter(Boolean);
      if (lines.length > 1000) await writeFile(this.failureLogPath, `${lines.slice(-1000).join('\n')}\n`, 'utf8');
    });
    await this.failureLogWrite;
  }

  async removeChannel(channelUrl: string) {
    const channels = (await this.getChannels()).filter((channel) => channel.url !== channelUrl);
    await this.persist(this.channelsPath, channels);
    return channels;
  }

  async reorderChannels(urls: string[]) {
    const channels = await this.getChannels();
    if (!Array.isArray(urls) || urls.length !== channels.length || new Set(urls).size !== channels.length) {
      throw new BadRequestException('De kanaalvolgorde is ongeldig');
    }
    const byUrl = new Map(channels.map((channel) => [channel.url, channel]));
    const reordered = urls.map((url) => byUrl.get(url));
    if (reordered.some((channel) => !channel)) throw new BadRequestException('De kanaalvolgorde bevat onbekende kanalen');
    const result = reordered as ChannelBookmark[];
    await this.persist(this.channelsPath, result);
    await this.prioritizeQueue();
    await this.saveQueue();
    return result;
  }

  private async prioritizeQueue() {
    if (this.queue.length < 2) return;
    const channels = await this.getChannels();
    const priority = new Map<string, number>();
    for (const [rank, channel] of channels.entries()) {
      const videos = await this.getCachedChannelVideos(channel.url);
      for (const video of videos ?? []) {
        const existing = priority.get(video.id);
        if (existing === undefined || rank < existing) priority.set(video.id, rank);
      }
    }
    const originalOrder = new Map(this.queue.map((id, index) => [id, index]));
    this.queue.sort((a, b) =>
      (priority.get(a) ?? Number.MAX_SAFE_INTEGER) - (priority.get(b) ?? Number.MAX_SAFE_INTEGER)
      || originalOrder.get(a)! - originalOrder.get(b)!,
    );
  }

  private parseChannelUrl(channelUrl: string) {
    let parsed: URL;
    try { parsed = new URL(channelUrl); }
    catch { throw new BadRequestException('Ongeldige URL'); }
    if (!/(^|\.)youtube\.com$/.test(parsed.hostname)) throw new BadRequestException('Alleen youtube.com-links zijn toegestaan');
    return parsed;
  }

  private channelTitle(url: URL) {
    const finalPart = url.pathname.split('/').filter(Boolean).filter((part) => !['videos', 'streams', 'shorts'].includes(part)).at(-1);
    return finalPart ? decodeURIComponent(finalPart) : url.hostname;
  }

  private get downloadDir() {
    if (!this.configuredDir) throw new ConflictException('Configureer eerst een opslagmap');
    return this.configuredDir;
  }

  private async persist(path: string, data: unknown) {
    const temporaryPath = `${path}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(data, null, 2), 'utf8');
    await rename(temporaryPath, path);
  }

  private saveQueue() {
    const snapshot = [...this.queue];
    this.queueWrite = this.queueWrite.catch(() => undefined).then(() => this.persist(this.queuePath, snapshot));
    return this.queueWrite;
  }

  private saveSubtitleQueue() {
    const snapshot = [...this.subtitleQueue];
    this.subtitleQueueWrite = this.subtitleQueueWrite.catch(() => undefined)
      .then(() => this.persist(this.subtitleQueuePath, snapshot));
    return this.subtitleQueueWrite;
  }

  private async saveVideos(videos: VideoInfo[]) {
    let catalog: Record<string, VideoInfo> = {};
    try { catalog = JSON.parse(await readFile(this.catalogPath, 'utf8')) as Record<string, VideoInfo>; }
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
    await this.persist(this.catalogPath, catalog);
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
      const catalog = JSON.parse(await readFile(this.catalogPath, 'utf8')) as Record<string, VideoInfo>;
      const pending = Object.values(catalog).filter((video) => !video.keywordsDutch?.length).map((video) => ({
        ...video,
        keywordsEnglish: video.keywordsEnglish ?? video.keywords ?? [],
        keywordsDutch: video.keywordsDutch ?? [],
      }));
      if (pending.length) await this.saveVideos(await this.withDutchKeywords(pending));
    } catch { /* Keep the collection usable if translation is unavailable. */ }
  }

  async searchVideos(query: string, offset = 0, limit = 20) {
    let catalog: Record<string, VideoInfo> = {};
    try { catalog = JSON.parse(await readFile(this.catalogPath, 'utf8')) as Record<string, VideoInfo>; }
    catch { /* Existing downloaded files can still be listed from their filenames. */ }
    let downloaded: Set<string>;
    let localVideos: VideoInfo[] = [];
    try {
      const files = await readdir(this.downloadDir);
      localVideos = files.flatMap((file) => {
        const id = FILE_ID_RE.exec(file)?.[1];
        if (!id) return [];
        const title = file.replace(/\s*\[[A-Za-z0-9_-]{11}\]\.[^.]+$/, '');
        const keywords = [...new Set(title.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
        return [{ id, title, thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, duration: null, keywords, keywordsEnglish: keywords, keywordsDutch: [] }];
      });
      downloaded = new Set(localVideos.map((video) => video.id));
    } catch { downloaded = new Set(); }
    const merged = new Map(localVideos.map((video) => [video.id, video]));
    for (const video of Object.values(catalog)) {
      if (downloaded.has(video.id)) merged.set(video.id, video);
    }
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matches = [...merged.values()].filter((video) => {
      const searchable = `${video.title} ${video.keywords.join(' ')}`.toLocaleLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    return {
      items: matches.slice(safeOffset, safeOffset + safeLimit),
      total: matches.length,
      offset: safeOffset,
      hasMore: safeOffset + safeLimit < matches.length,
    };
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

  private isMembersOnly(info: any) {
    return String(info?.availability ?? '').toLocaleLowerCase() === 'subscriber_only';
  }

  /** Enrich flat playlist results in the background so the UI can show the channel quickly. */
  private async enrichChannelMetadata(target: string) {
    const p = spawn(this.ytdlp, [
      '--skip-download',
      '--dump-json',
      '--ignore-errors',
      '--no-warnings',
      ...this.cookieArgs,
      target,
    ]);
    const lines = createInterface({ input: p.stdout, crlfDelay: Infinity });
    let batch: VideoInfo[] = [];
    let writes = Promise.resolve();
    const saveBatch = (videos: VideoInfo[]) => {
      writes = writes.then(async () => {
        try { await this.saveVideos(await this.withDutchKeywords(videos)); }
        catch { /* Keep the fast import metadata if enrichment or translation fails. */ }
      });
    };
    lines.on('line', (line) => {
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
    });
    await new Promise<void>((done) => {
      p.on('error', () => done());
      p.on('close', () => done());
    });
    lines.close();
    if (batch.length) saveBatch(batch);
    await writes;
  }

  listChannel(channelUrl: string): Promise<VideoInfo[]> {
    const u = this.parseChannelUrl(channelUrl);
    const isPlaylist = u.pathname.startsWith('/playlist');
    const hasTab = /\/(videos|streams|shorts)\/?$/.test(u.pathname);
    const target =
      isPlaylist || hasTab ? u.href : u.href.replace(/\/$/, '') + '/videos';

    return new Promise((ok, fail) => {
      const p = spawn(this.ytdlp, [
        '--skip-download',
        '--flat-playlist',
        '--dump-json',
        '--no-warnings',
        ...this.cookieArgs,
        target,
      ]);
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', (e) =>
        fail(new BadRequestException(`yt-dlp niet gevonden: ${e.message}`)),
      );
      p.on('close', async (code) => {
        if (code !== 0 && !out)
          return fail(
            new BadRequestException(err.trim() || 'yt-dlp is mislukt'),
          );
        const videos: VideoInfo[] = out
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((j) => ID_RE.test(j.id) && !this.isMembersOnly(j))
          .map((j) => this.toVideoInfo(j));
        try {
          await this.saveVideos(videos);
          void this.enrichChannelMetadata(target);
          ok(videos);
        } catch (error) {
          fail(new BadRequestException(`Metadata opslaan is mislukt: ${String(error)}`));
        }
      });
    });
  }

  /** Bron van waarheid is de map zelf: verwijder je een bestand, dan wordt de video weer selecteerbaar. */
  private async downloadedIds(): Promise<string[]> {
    if (!this.configuredDir) return [];
    const files = await readdir(this.downloadDir);
    return files
      .map((f) => FILE_ID_RE.exec(f)?.[1])
      .filter((id): id is string => !!id);
  }

  async getDownloadedVideoPath(id: string) {
    if (!ID_RE.test(id)) throw new BadRequestException('Ongeldig video-id');
    let files: string[];
    try { files = await readdir(this.downloadDir); }
    catch { throw new NotFoundException('De video-opslagmap is niet beschikbaar'); }
    const filename = files.find((file) => FILE_ID_RE.exec(file)?.[1] === id);
    if (!filename) throw new NotFoundException('Gedownloade video niet gevonden');
    return join(this.downloadDir, filename);
  }

  private findSubtitleFile(files: string[], id: string, language: 'en' | 'nl') {
    const pattern = new RegExp(`\\[${id}\\]\\.${language}(?:[-_][a-z0-9]+)*\\.vtt$`, 'i');
    const candidates = files.filter((file) => pattern.test(file));
    return candidates.find((file) => file.toLocaleLowerCase().endsWith(`.${language}.vtt`))
      ?? candidates.sort()[0];
  }

  private async ensureDownloadedSubtitles(id: string) {
    if (this.subtitleAttempts.has(id)) return;
    let task = this.subtitleDownloads.get(id);
    if (!task) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      task = { promise, resolve };
      this.subtitleDownloads.set(id, task);
      if (!this.subtitleQueue.includes(id) && !this.activeSubtitleDownloads.has(id)) {
        this.subtitleQueue.push(id);
        try { await this.saveSubtitleQueue(); }
        catch (error) {
          this.subtitleQueue = this.subtitleQueue.filter((queuedId) => queuedId !== id);
          this.subtitleDownloads.delete(id);
          task.resolve();
          throw error;
        }
      }
      this.pumpSubtitleQueue();
    }
    await task.promise;
  }

  private pumpSubtitleQueue() {
    if (!this.configuredDir || this.activeSubtitleDownloads.size) return;
    const id = this.subtitleQueue.find((queuedId) => !this.activeSubtitleDownloads.has(queuedId));
    if (!id) return;
    this.activeSubtitleDownloads.add(id);
    void this.downloadSubtitles(id).catch((error) => {
      console.error(`Ondertitelproces mislukt voor ${id}: ${String(error)}`);
    }).finally(() => {
      this.activeSubtitleDownloads.delete(id);
      this.subtitleQueue = this.subtitleQueue.filter((queuedId) => queuedId !== id);
      this.subtitleAttempts.add(id);
      this.subtitleDownloads.get(id)?.resolve();
      this.subtitleDownloads.delete(id);
      void this.saveSubtitleQueue().catch((error) => console.error(`Ondertitelwachtrij opslaan mislukt: ${String(error)}`));
      this.pumpSubtitleQueue();
    });
  }

  private downloadSubtitles(id: string) {
    return new Promise<void>((done) => {
      let stderr = '';
      const child = spawn(this.ytdlp, [
        '--no-playlist',
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs',
        'en.*,nl.*',
        '--sub-format',
        'vtt/best',
        '--convert-subs',
        'vtt',
        ...this.cookieArgs,
        '-o',
        join(this.downloadDir, '%(title)s [%(id)s].%(ext)s'),
        `https://www.youtube.com/watch?v=${id}`,
      ]);
      child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8000); });
      child.on('error', (error) => {
        console.error(`Ondertitels ophalen mislukt voor ${id}: ${error.message}`);
        done();
      });
      child.on('close', (code) => {
        if (code !== 0 && stderr) console.error(`Ondertitels ophalen mislukt voor ${id}: ${stderr}`);
        done();
      });
    });
  }

  async getDownloadedSubtitlePath(id: string, language: string) {
    if (!ID_RE.test(id)) throw new BadRequestException('Ongeldig video-id');
    if (language !== 'en' && language !== 'nl') throw new BadRequestException('Ongeldige ondertitelingstaal');
    await this.getDownloadedVideoPath(id);

    let files = await readdir(this.downloadDir);
    let filename = this.findSubtitleFile(files, id, language);
    if (!filename) {
      await this.ensureDownloadedSubtitles(id);
      files = await readdir(this.downloadDir);
      filename = this.findSubtitleFile(files, id, language);
    }
    if (!filename) throw new NotFoundException(`Geen ${language === 'nl' ? 'Nederlandse' : 'Engelse'} ondertiteling beschikbaar`);
    return join(this.downloadDir, filename);
  }

  async getState() {
    let catalog: Record<string, VideoInfo> = {};
    try { catalog = JSON.parse(await readFile(this.catalogPath, 'utf8')) as Record<string, VideoInfo>; }
    catch { /* Show the id if metadata has not been collected yet. */ }
    const describe = (id: string, progress: number) => ({
      id,
      progress,
      title: catalog[id]?.title ?? id,
      thumbnail: catalog[id]?.thumbnail ?? `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    });
    const active = [...this.active.entries()].map(([id, data]) => describe(id, data.progress));
    const queuedItems = this.queue.slice(0, 8).map((id) => describe(id, 0));
    return {
      dir: this.configuredDir ?? '',
      downloaded: await this.downloadedIds(),
      queued: [...this.queue],
      queuedItems,
      current: active[0] ?? null,
      active,
      syncEnabled: this.syncEnabled,
      failed: [...this.failed],
    };
  }

  async enqueue(ids: string[]) {
    const done = new Set(await this.downloadedIds());
    for (const id of ids) {
      if (!ID_RE.test(id))
        throw new BadRequestException(`Ongeldig video-id: ${id}`);
      if (done.has(id) || this.queue.includes(id) || this.active.has(id))
        continue;
      this.failed.delete(id);
      this.queue.push(id);
    }
    await this.prioritizeQueue();
    await this.saveQueue();
    this.pump();
    return this.getState();
  }

  private pump() {
    while (this.syncEnabled && this.active.size < this.maxParallelDownloads && this.queue.length) {
      const nextIndex = this.queue.findIndex((id) => !this.active.has(id));
      if (nextIndex < 0) break;
      const id = this.queue.splice(nextIndex, 1)[0];
      this.active.set(id, { progress: 0 });
      void this.saveQueue().catch(() => undefined);
      void this.run(id).catch(async (error) => {
        try { await this.recordFailure(id, String(error)); } catch { /* Keep the queue moving. */ }
        return false;
      }).then(async (ok) => {
        if (ok) {
          void this.ensureDownloadedSubtitles(id).catch((error) => {
            console.error(`Ondertiteljob in wachtrij zetten mislukt voor ${id}: ${String(error)}`);
          });
        }
        if (this.pausedIds.has(id)) {
          this.pausedIds.delete(id);
          if (ok) this.queue = this.queue.filter((queuedId) => queuedId !== id);
          else await this.downloadedIds().then((done) => {
            if (done.includes(id)) this.queue = this.queue.filter((queuedId) => queuedId !== id);
          }).catch(() => undefined);
        } else if (!ok) {
          this.failed.add(id);
        }
        this.active.delete(id);
        void this.saveQueue().catch(() => undefined).finally(() => this.pump());
      });
    }
  }

  private run(id: string): Promise<boolean> {
    return new Promise((resolveRun) => {
      let stderr = '';
      let settled = false;
      const p = spawn(this.ytdlp, [
        '--no-playlist',
        '--newline',
        '-f',
        'bv*[height<=1080]+ba/b[height<=1080]',
        '--merge-output-format',
        'mp4',
        ...this.cookieArgs,
        '-o',
        join(this.downloadDir, '%(title)s [%(id)s].%(ext)s'),
        `https://www.youtube.com/watch?v=${id}`,
      ]);
      this.downloadProcesses.set(id, p);
      p.stdout.on('data', (d) => {
        const m = /(\d+(?:\.\d+)?)%/.exec(String(d));
        if (m && this.active.has(id))
          this.active.get(id)!.progress = Math.round(parseFloat(m[1]));
      });
      p.stderr.on('data', (d) => {
        stderr += String(d);
        stderr = stderr.split(/\r?\n/).slice(-100).join('\n');
        if (stderr.length > 24_000) stderr = stderr.slice(-24_000);
      });
      const finish = async (ok: boolean, reason: string) => {
        if (settled) return;
        settled = true;
        this.downloadProcesses.delete(id);
        if (!ok && !this.pausedIds.has(id)) {
          try { await this.recordFailure(id, stderr || reason); }
          catch (error) { console.error(`Faallog opslaan mislukt voor ${id}: ${String(error)}`); }
        }
        resolveRun(ok);
      };
      p.on('error', (error) => void finish(false, error.message));
      p.on('close', (code) => void finish(code === 0, `yt-dlp sloot af met code ${code}`));
    });
  }
}

import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { mkdirSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
import { homedir } from 'os';
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

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
// Bestandsnaam: "Titel [videoId].mp4" (zie output-template hieronder)
const FILE_ID_RE = /\[([A-Za-z0-9_-]{11})\]\.[^.]+$/;
export interface ChannelBookmark { url: string; title: string; addedAt: string; autoSync: boolean; }
export interface ChannelSuggestion { title: string; url: string; verified: boolean; }
export interface ChannelSuggestionSubsection { title: string; channels: ChannelSuggestion[]; }
export interface ChannelSuggestionSection { title: string; subsections: ChannelSuggestionSubsection[]; }

@Injectable()
export class VideosService implements OnModuleInit {
  private static readonly MAX_JOB_ATTEMPTS = 5;
  private static readonly COOKIE_BROWSERS = ['chrome', 'chromium', 'firefox', 'safari', 'edge', 'brave', 'opera', 'vivaldi', 'whale'] as const;
  private readonly dataDir = process.env.APP_DATA_DIR
    ? resolve(process.env.APP_DATA_DIR)
    : join(homedir(), '.youtubedownloader');
  private readonly settingsPath = join(this.dataDir, 'settings.json');
  private readonly catalogPath = join(this.dataDir, 'videos.json');
  private readonly channelsPath = join(this.dataDir, 'channels.json');
  private readonly channelCacheDir = join(this.dataDir, 'channel-cache');
  private readonly queuePath = join(this.dataDir, 'sync-queue.json');
  private readonly subtitleQueuePath = join(this.dataDir, 'subtitle-queue.json');
  private readonly rateLimitPath = join(this.dataDir, 'rate-limit.json');
  private readonly failureLogPath = join(this.dataDir, 'sync-failures.log');
  private readonly suggestionsPath = process.env.SUGGESTIONS_PATH ?? resolve(process.cwd(), '../docs/skills/suggestions.json');
  private configuredDir: string | null = null;
  private readonly defaultDownloadDir = process.env.DOWNLOAD_DIR ? resolve(process.env.DOWNLOAD_DIR) : null;
  private cookiesBrowser: string = process.env.YTDLP_COOKIES_BROWSER ?? 'chrome';
  private readonly cookiesFile = process.env.YTDLP_COOKIES_FILE;
  private readonly useBrowserCookies = process.env.YTDLP_USE_BROWSER_COOKIES !== 'false';
  private language: 'en' | 'nl' = 'en';

  private queue: string[] = [];
  private subtitleQueue: string[] = [];
  private active = new Map<string, { progress: number }>();
  private activeSubtitleDownloads = new Set<string>();
  private subtitleRateLimitAttempts = new Map<string, number>();
  private subtitleNextRunAt = 0;
  private subtitlePumpTimer: ReturnType<typeof setTimeout> | null = null;
  private downloadNextRunAt = 0;
  private downloadPumpTimer: ReturnType<typeof setTimeout> | null = null;
  private rateLimitedDownloads = new Set<string>();
  private downloadErrors = new Map<string, string>();
  private persistedProgress = new Map<string, number>();
  private downloadKills = new Map<string, () => void>();
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

  constructor(private readonly storage: AppStorage, private readonly runner: YtdlpRunner) {
    mkdirSync(this.dataDir, { recursive: true });
    if (this.defaultDownloadDir) mkdirSync(this.defaultDownloadDir, { recursive: true });
    if (process.env.DEEPL_AUTH_KEY) void this.backfillDutchKeywords();
  }

  async onModuleInit() {
    await this.getSettings();
    try {
      const savedQueue = this.storage.readJson<string[]>(this.queuePath);
      for (const id of savedQueue.filter((item) => ID_RE.test(item))) this.storage.ensureJob('video', id);
    } catch { /* No pending sync work yet. */ }
    const downloaded = new Set(await this.downloadedIds());
    const recoveredVideos = this.storage.recoverJobs('video');
    for (const id of downloaded) this.storage.completeJob('video', id);
    this.queue = [...new Set(recoveredVideos.filter((id) => !downloaded.has(id)))];
    await this.saveQueue();
    try {
      const savedSubtitleQueue = this.storage.readJson<string[]>(this.subtitleQueuePath);
      for (const id of savedSubtitleQueue.filter((item) => ID_RE.test(item))) this.storage.ensureJob('subtitle', id);
    } catch { /* Subtitle work is queued after a video has completed. */ }
    const recoveredSubtitles = this.storage.recoverJobs('subtitle');
    this.subtitleQueue = [...new Set(recoveredSubtitles.filter((id) => downloaded.has(id)))];
    for (const id of recoveredSubtitles.filter((queuedId) => !downloaded.has(queuedId))) {
      this.storage.failJob('subtitle', id, 'skipped', 'The source video is no longer present in the downloads folder.', 'source_missing');
    }
    await this.saveSubtitleQueue();
    this.failed = new Set(this.storage.jobsByStatus('video', ['failed', 'skipped']).map((job) => job.id));
    try {
      const savedRetryAt = this.storage.readJson<{ retryAt?: number }>(this.rateLimitPath);
      if (typeof savedRetryAt.retryAt === 'number' && savedRetryAt.retryAt > Date.now()) {
        this.downloadNextRunAt = savedRetryAt.retryAt;
      }
    } catch { /* No saved YouTube rate limit cooldown. */ }
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
    let saved: {
      downloadDir?: string; maxParallelDownloads?: number; cookiesBrowser?: string; syncEnabled?: boolean; language?: string;
    } = {};
    try {
      saved = this.storage.readJson<typeof saved>(this.settingsPath);
    } catch { /* First run: use defaults. */ }

    if (this.defaultDownloadDir) {
      this.configuredDir = this.defaultDownloadDir;
      if (saved.downloadDir !== this.defaultDownloadDir) {
        await this.persist(this.settingsPath, this.settingsData(this.configuredDir));
      }
    } else if (saved.downloadDir) {
      this.configuredDir = resolve(saved.downloadDir);
    }
    if (Number.isInteger(saved.maxParallelDownloads) && saved.maxParallelDownloads! >= 1) {
      this.maxParallelDownloads = Math.min(saved.maxParallelDownloads!, 8);
    }
    if (saved.cookiesBrowser && VideosService.COOKIE_BROWSERS.includes(saved.cookiesBrowser as typeof VideosService.COOKIE_BROWSERS[number])) this.cookiesBrowser = saved.cookiesBrowser;
    if (typeof saved.syncEnabled === 'boolean') this.syncEnabled = saved.syncEnabled;
    if (saved.language === 'en' || saved.language === 'nl') this.language = saved.language;
    return {
      downloadDir: this.configuredDir,
      downloadDirFixed: !!this.defaultDownloadDir,
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
    if (this.cookiesFile) return ['--cookies', this.cookiesFile];
    if (!this.useBrowserCookies) return [];
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
      for (const id of this.active.keys()) this.downloadKills.get(id)?.();
    } else {
      await this.prioritizeQueue();
      this.pump();
    }
    return { enabled: this.syncEnabled, state: await this.getState() };
  }

  async setDownloadDir(path: string) {
    if (this.defaultDownloadDir) {
      this.configuredDir = this.defaultDownloadDir;
      await this.persist(this.settingsPath, this.settingsData(this.configuredDir));
      return this.getSettings();
    }
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
      const videos = this.storage.readJson<VideoInfo[]>(this.channelCachePath(url));
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
      const lines = this.storage.readText(this.failureLogPath).split(/\r?\n/).filter(Boolean);
      return { lines: lines.slice(-safeLimit), totalLines: lines.length };
    } catch { return { lines: [], totalLines: 0 }; }
  }

  private async recordFailure(id: string, details: string) {
    let title = id;
    try {
      const catalog = this.storage.readJson<Record<string, VideoInfo>>(this.catalogPath);
      title = catalog[id]?.title ?? id;
    } catch { /* The video ID still identifies the failed item. */ }
    const detailLines = details.split(/\r?\n/).filter(Boolean).slice(-80);
    const entry = [
      `[${new Date().toISOString()}] FAILED ${title} [${id}]`,
      ...(detailLines.length ? detailLines : ['yt-dlp stopped without reporting a reason.']),
      '',
    ].join('\n');
    this.failureLogWrite = this.failureLogWrite.catch(() => undefined).then(async () => {
      this.storage.appendFailure(entry);
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

  private retryDelay(errorClass: string, attempts: number) {
    const base = errorClass === 'rate_limited' ? 60 * 60_000 : 30_000;
    const cap = errorClass === 'rate_limited' ? 6 * 60 * 60_000 : 30 * 60_000;
    return Math.round(Math.min(cap, base * 2 ** Math.max(0, attempts - 1)) * (0.8 + Math.random() * 0.4));
  }

  private formatDelay(delayMs: number) {
    if (delayMs < 60_000) return `${Math.ceil(delayMs / 1000)} seconden`;
    if (delayMs < 60 * 60_000) return `${Math.ceil(delayMs / 60_000)} minuten`;
    const hours = Math.floor(delayMs / (60 * 60_000));
    const minutes = Math.ceil((delayMs % (60 * 60_000)) / 60_000);
    return minutes ? `${hours} uur en ${minutes} minuten` : `${hours} uur`;
  }

  private get downloadDir() {
    if (!this.configuredDir) throw new ConflictException('Configureer eerst een opslagmap');
    return this.configuredDir;
  }

  private async persist(path: string, data: unknown) {
    this.storage.writeJson(path, data);
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
      const catalog = this.storage.readJson<Record<string, VideoInfo>>(this.catalogPath);
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
    try { catalog = this.storage.readJson<Record<string, VideoInfo>>(this.catalogPath); }
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
    const indexedMatches = new Set(this.storage.searchVideoIds(query));
    const matches = [...merged.values()].filter((video) => {
      if (indexedMatches.has(video.id)) return true;
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
    await result;
    if (batch.length) saveBatch(batch);
    await writes;
  }

  async listChannel(channelUrl: string): Promise<VideoInfo[]> {
    const u = this.parseChannelUrl(channelUrl);
    const isPlaylist = u.pathname.startsWith('/playlist');
    const hasTab = /\/(videos|streams|shorts)\/?$/.test(u.pathname);
    const target = isPlaylist || hasTab ? u.href : u.href.replace(/\/$/, '') + '/videos';

    const { result } = this.runner.run([
      '--skip-download', '--flat-playlist', '--dump-json', '--no-warnings',
      '--sleep-requests', '2',
      ...this.cookieArgs,
      target,
    ]);
    const { ok, stdout, stderr } = await result;
    if (!ok && !stdout) throw new BadRequestException(stderr.trim() || 'yt-dlp is mislukt');
    const videos: VideoInfo[] = stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((j) => ID_RE.test(j.id) && !this.isMembersOnly(j))
      .map((j) => this.toVideoInfo(j));
    try {
      await this.saveVideos(videos);
      void this.enrichChannelMetadata(target);
      return videos;
    } catch (error) {
      throw new BadRequestException(`Metadata opslaan is mislukt: ${String(error)}`);
    }
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
    if (this.subtitleAttempts.has(id) || (this.subtitleQueue.includes(id) && Date.now() < this.subtitleNextRunAt)) return;
    const retryAt = this.storage.jobNextAttemptAt('subtitle', id);
    if (retryAt && retryAt > Date.now() && this.subtitleQueue.includes(id)) return;
    let task = this.subtitleDownloads.get(id);
    if (!task) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      task = { promise, resolve };
      this.subtitleDownloads.set(id, task);
      if (!this.subtitleQueue.includes(id) && !this.activeSubtitleDownloads.has(id)) {
        this.storage.ensureJob('subtitle', id);
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
    const waitMs = this.subtitleNextRunAt - Date.now();
    if (waitMs > 0) {
      this.scheduleSubtitlePump(waitMs);
      return;
    }
    const eligible = this.subtitleQueue.find((queuedId) => !this.activeSubtitleDownloads.has(queuedId)
      && (this.storage.jobNextAttemptAt('subtitle', queuedId) ?? 0) <= Date.now());
    if (!eligible) {
      const next = this.subtitleQueue.map((queuedId) => this.storage.jobNextAttemptAt('subtitle', queuedId) ?? 0)
        .filter((time) => time > Date.now()).sort((a, b) => a - b)[0];
      if (next) this.scheduleSubtitlePump(Math.max(250, next - Date.now()));
      return;
    }
    const id = eligible;
    this.storage.startJob('subtitle', id);
    this.activeSubtitleDownloads.add(id);
    void this.downloadSubtitles(id).then(async (result) => {
      this.activeSubtitleDownloads.delete(id);
      if (!result.success) {
        const failure = result.error ?? 'Subtitle download failed without diagnostic output';
        const classification = this.runner.classifyError(failure);
        const attempts = this.storage.jobAttemptCount('subtitle', id);
        if (classification.retryable && attempts < VideosService.MAX_JOB_ATTEMPTS) {
          const delayMs = this.retryDelay(classification.errorClass, attempts);
          this.subtitleNextRunAt = Date.now() + 2_000;
          const nextAttemptAt = Date.now() + delayMs;
          this.storage.retryJob('subtitle', id, nextAttemptAt, failure, classification.errorClass);
          console.warn(`Ondertitels ophalen voor ${id} is tijdelijk mislukt; poging ${attempts + 1}/${VideosService.MAX_JOB_ATTEMPTS} over ${this.formatDelay(delayMs)}.`);
          this.subtitleDownloads.get(id)?.resolve();
          this.subtitleDownloads.delete(id);
          await this.saveSubtitleQueue().catch((error) => console.error(`Ondertitelwachtrij opslaan mislukt: ${String(error)}`));
          this.scheduleSubtitlePump(2_000);
          return;
        }
        const status = classification.permanent ? 'skipped' : 'failed';
        this.storage.failJob('subtitle', id, status, failure, classification.errorClass);
        this.subtitleQueue = this.subtitleQueue.filter((queuedId) => queuedId !== id);
        this.subtitleAttempts.add(id);
        console.error(`Ondertiteljob ${id} ${status === 'skipped' ? 'overgeslagen' : 'mislukt'}: ${failure}`);
        this.subtitleDownloads.get(id)?.resolve();
        this.subtitleDownloads.delete(id);
        await this.saveSubtitleQueue().catch((error) => console.error(`Ondertitelwachtrij opslaan mislukt: ${String(error)}`));
        this.scheduleSubtitlePump(2_000);
        return;
      }
      this.subtitleQueue = this.subtitleQueue.filter((queuedId) => queuedId !== id);
      this.storage.completeJob('subtitle', id);
      this.subtitleAttempts.add(id);
      this.subtitleRateLimitAttempts.delete(id);
      this.subtitleDownloads.get(id)?.resolve();
      this.subtitleDownloads.delete(id);
      this.subtitleNextRunAt = Date.now() + 2_000;
      await this.saveSubtitleQueue().catch((error) => console.error(`Ondertitelwachtrij opslaan mislukt: ${String(error)}`));
      this.scheduleSubtitlePump(2_000);
    }).catch(async (error) => {
      this.activeSubtitleDownloads.delete(id);
      this.subtitleQueue = this.subtitleQueue.filter((queuedId) => queuedId !== id);
      this.storage.failJob('subtitle', id, 'failed', String(error), 'process_error');
      this.subtitleAttempts.add(id);
      this.subtitleDownloads.get(id)?.resolve();
      this.subtitleDownloads.delete(id);
      console.error(`Ondertitelproces mislukt voor ${id}: ${String(error)}`);
      await this.saveSubtitleQueue().catch((saveError) => console.error(`Ondertitelwachtrij opslaan mislukt: ${String(saveError)}`));
      this.scheduleSubtitlePump(2_000);
    });
  }

  private scheduleSubtitlePump(delayMs: number) {
    if (this.subtitlePumpTimer) clearTimeout(this.subtitlePumpTimer);
    this.subtitlePumpTimer = setTimeout(() => {
      this.subtitlePumpTimer = null;
      this.pumpSubtitleQueue();
    }, delayMs);
    this.subtitlePumpTimer.unref?.();
  }

  private async downloadSubtitles(id: string): Promise<{ success: boolean; error?: string }> {
    const { result } = this.runner.run([
      '--no-playlist', '--skip-download',
      '--sleep-subtitles', '5',
      '--retries', '3',
      '--retry-sleep', 'http:exp=5:60',
      '--sleep-requests', '2',
      '--write-subs', '--write-auto-subs',
      '--sub-langs', 'en.*,nl.*',
      '--sub-format', 'vtt/best',
      '--convert-subs', 'vtt',
      ...this.cookieArgs,
      '-o', join(this.downloadDir, '%(title)s [%(id)s].%(ext)s'),
      `https://www.youtube.com/watch?v=${id}`,
    ]);
    const { ok, stderr } = await result;
    return { success: ok, error: ok ? undefined : (stderr || undefined) };
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
    try { catalog = this.storage.readJson<Record<string, VideoInfo>>(this.catalogPath); }
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
      retrying: this.storage.jobsByStatus('video', ['retry_wait']).map((job) => ({
        id: job.id,
        attempt: job.attempt_count,
        nextAttemptAt: job.next_attempt_at,
        errorClass: job.error_class,
      })),
      subtitleRetrying: this.storage.jobsByStatus('subtitle', ['retry_wait']).map((job) => ({
        id: job.id,
        attempt: job.attempt_count,
        nextAttemptAt: job.next_attempt_at,
        errorClass: job.error_class,
      })),
      current: active[0] ?? null,
      active,
      syncEnabled: this.syncEnabled,
      retryAt: this.downloadNextRunAt || null,
      failed: [...this.failed],
    };
  }

  async enqueue(ids: string[], allowFailedRetry = false) {
    const done = new Set(await this.downloadedIds());
    for (const id of ids) {
      if (!ID_RE.test(id))
        throw new BadRequestException(`Ongeldig video-id: ${id}`);
      if (done.has(id) || this.queue.includes(id) || this.active.has(id))
        continue;
      if (this.failed.has(id) && !allowFailedRetry) continue;
      this.failed.delete(id);
      this.storage.resetJob('video', id);
      this.queue.push(id);
    }
    await this.prioritizeQueue();
    await this.saveQueue();
    this.pump();
    return this.getState();
  }

  private pump() {
    const waitMs = this.downloadNextRunAt - Date.now();
    if (waitMs > 0) {
      this.scheduleDownloadPump(waitMs);
      return;
    }
    if (this.downloadNextRunAt) {
      this.downloadNextRunAt = 0;
      void this.persist(this.rateLimitPath, { retryAt: 0 });
    }
    while (this.syncEnabled && this.active.size < this.maxParallelDownloads && this.queue.length) {
      const nextIndex = this.queue.findIndex((id) => !this.active.has(id)
        && (this.storage.jobNextAttemptAt('video', id) ?? 0) <= Date.now());
      if (nextIndex < 0) {
        const next = this.queue.map((id) => this.storage.jobNextAttemptAt('video', id) ?? 0)
          .filter((time) => time > Date.now()).sort((a, b) => a - b)[0];
        if (next) this.scheduleDownloadPump(Math.max(250, next - Date.now()));
        break;
      }
      const id = this.queue.splice(nextIndex, 1)[0];
      this.active.set(id, { progress: 0 });
      this.storage.startJob('video', id);
      this.persistedProgress.delete(id);
      void this.saveQueue().catch(() => undefined);
      void this.run(id).catch(async (error) => {
        try { await this.recordFailure(id, String(error)); } catch { /* Keep the queue moving. */ }
        return false;
      }).then(async (ok) => {
        if (ok) {
          this.storage.completeJob('video', id);
          this.downloadErrors.delete(id);
          void this.ensureDownloadedSubtitles(id).catch((error) => {
            console.error(`Ondertiteljob in wachtrij zetten mislukt voor ${id}: ${String(error)}`);
          });
        }
        if (!ok && this.rateLimitedDownloads.has(id) && !this.pausedIds.has(id)) {
          this.rateLimitedDownloads.delete(id);
          const attempts = this.storage.jobAttemptCount('video', id);
          const error = this.downloadErrors.get(id) ?? 'YouTube rate limit';
          if (attempts < VideosService.MAX_JOB_ATTEMPTS) {
            const delayMs = this.retryDelay('rate_limited', attempts);
            this.downloadNextRunAt = Date.now() + delayMs;
            this.storage.retryJob('video', id, this.downloadNextRunAt, error, 'rate_limited');
            if (!this.queue.includes(id)) this.queue.unshift(id);
            console.warn(`YouTube heeft de downloadsnelheid beperkt. Video ${id} blijft in de wachtrij; opnieuw proberen over ${this.formatDelay(delayMs)}.`);
            await this.persist(this.rateLimitPath, { retryAt: this.downloadNextRunAt }).catch((saveError) => console.error(`Rate-limit wachttijd opslaan mislukt: ${String(saveError)}`));
          } else {
            this.storage.failJob('video', id, 'failed', error, 'rate_limited');
            this.failed.add(id);
          }
          this.downloadErrors.delete(id);
        } else if (this.pausedIds.has(id)) {
          this.pausedIds.delete(id);
          if (ok) {
            this.storage.completeJob('video', id);
            this.queue = this.queue.filter((queuedId) => queuedId !== id);
          } else {
            this.rateLimitedDownloads.delete(id);
            this.storage.setJobPending('video', id);
            if (!this.queue.includes(id)) this.queue.unshift(id);
            await this.downloadedIds().then((done) => {
              if (done.includes(id)) this.queue = this.queue.filter((queuedId) => queuedId !== id);
              if (done.includes(id)) this.storage.completeJob('video', id);
            }).catch(() => undefined);
          }
        } else if (!ok) {
          const error = this.downloadErrors.get(id) ?? 'Download failed without diagnostic output';
          const classification = this.runner.classifyError(error);
          const attempts = this.storage.jobAttemptCount('video', id);
          if (classification.retryable && attempts < VideosService.MAX_JOB_ATTEMPTS) {
            const delayMs = this.retryDelay(classification.errorClass, attempts);
            this.storage.retryJob('video', id, Date.now() + delayMs, error, classification.errorClass);
            this.queue.push(id);
            console.warn(`Download van ${id} wordt opnieuw geprobeerd (${attempts + 1}/${VideosService.MAX_JOB_ATTEMPTS}) over ${this.formatDelay(delayMs)}.`);
          } else {
            this.storage.failJob('video', id, classification.permanent ? 'skipped' : 'failed', error, classification.errorClass);
            this.failed.add(id);
          }
          this.downloadErrors.delete(id);
        }
        this.active.delete(id);
        void this.saveQueue().catch(() => undefined).finally(() => {
          if (this.downloadNextRunAt > Date.now()) this.scheduleDownloadPump(this.downloadNextRunAt - Date.now());
          else this.pump();
        });
      });
    }
  }

  private scheduleDownloadPump(delayMs: number) {
    if (this.downloadPumpTimer) clearTimeout(this.downloadPumpTimer);
    this.downloadPumpTimer = setTimeout(() => {
      this.downloadPumpTimer = null;
      this.pump();
    }, delayMs);
    this.downloadPumpTimer.unref?.();
  }

  private run(id: string): Promise<boolean> {
    const { result, kill } = this.runner.run([
      '--no-playlist', '--newline',
      '--sleep-requests', '2',
      '--sleep-interval', '5',
      '--max-sleep-interval', '10',
      '--retries', '3',
      '--retry-sleep', 'http:exp=5:60',
      '-f', 'bv*[height<=1080]+ba/b[height<=1080]',
      '--merge-output-format', 'mp4',
      ...this.cookieArgs,
      '-o', join(this.downloadDir, '%(title)s [%(id)s].%(ext)s'),
      `https://www.youtube.com/watch?v=${id}`,
    ], {
      stderrLimit: 24_000,
      onProgress: (pct) => {
        if (!this.active.has(id)) return;
        this.active.get(id)!.progress = pct;
        if (pct === 100 || Math.abs(pct - (this.persistedProgress.get(id) ?? -5)) >= 5) {
          this.persistedProgress.set(id, pct);
          this.storage.updateJobProgress(id, pct);
        }
      },
    });
    this.downloadKills.set(id, kill);
    return result.then(async ({ ok, stderr, timedOut }) => {
      this.downloadKills.delete(id);
      const reason = timedOut ? 'yt-dlp timeout overschreden' : `yt-dlp sloot af met een fout`;
      const rateLimited = /account has been rate-limited by YouTube|rate-limited.{0,40}(?:hour|minute)|HTTP Error 429|Too Many Requests/i.test(stderr);
      if (rateLimited) this.rateLimitedDownloads.add(id);
      if (!ok) this.downloadErrors.set(id, stderr || reason);
      this.persistedProgress.delete(id);
      if (!ok && !rateLimited && !this.pausedIds.has(id)) {
        try { await this.recordFailure(id, stderr || reason); }
        catch (error) { console.error(`Faallog opslaan mislukt voor ${id}: ${String(error)}`); }
      }
      return ok;
    });
  }
}

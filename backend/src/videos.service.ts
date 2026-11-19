import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { mkdirSync, statfsSync } from 'fs';
import { readdir } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { AppStorage } from './app-storage.ts';
import { YtdlpRunner } from './yt-dlp-runner.ts';
import { ChannelService, type VideoInfo } from './channel.service.ts';

export type { VideoInfo, ChannelBookmark, ChannelSuggestion, ChannelSuggestionSubsection, ChannelSuggestionSection } from './channel.service.ts';

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
// Bestandsnaam: "Titel [videoId].mp4" (zie output-template hieronder)
const FILE_ID_RE = /\[([A-Za-z0-9_-]{11})\]\.[^.]+$/;

@Injectable()
export class VideosService implements OnModuleInit, OnModuleDestroy {
  private static readonly MAX_JOB_ATTEMPTS = 5;
  private static readonly COOKIE_BROWSERS = ['chrome', 'chromium', 'firefox', 'safari', 'edge', 'brave', 'opera', 'vivaldi', 'whale'] as const;
  private readonly dataDir = process.env.APP_DATA_DIR
    ? resolve(process.env.APP_DATA_DIR)
    : join(homedir(), '.youtubedownloader');
  private readonly settingsPath = join(this.dataDir, 'settings.json');
  private readonly queuePath = join(this.dataDir, 'sync-queue.json');
  private readonly subtitleQueuePath = join(this.dataDir, 'subtitle-queue.json');
  private readonly rateLimitPath = join(this.dataDir, 'rate-limit.json');
  private readonly failureLogPath = join(this.dataDir, 'sync-failures.log');
  private configuredDir: string | null = null;
  private readonly defaultDownloadDir = process.env.DOWNLOAD_DIR ? resolve(process.env.DOWNLOAD_DIR) : null;
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
  private readonly downloaded = new Set<string>();
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private queueWrite = Promise.resolve();
  private subtitleQueueWrite = Promise.resolve();
  private failureLogWrite = Promise.resolve();
  private subtitleDownloads = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  private subtitleAttempts = new Set<string>();

  constructor(
    private readonly storage: AppStorage,
    private readonly runner: YtdlpRunner,
    private readonly channelService: ChannelService,
  ) {
    if (this.defaultDownloadDir) mkdirSync(this.defaultDownloadDir, { recursive: true });
  }

  async onModuleInit() {
    await this.getSettings();
    for (const id of await this.scanDownloadDir()) this.downloaded.add(id);
    try {
      const savedQueue = this.storage.readJson<string[]>(this.queuePath);
      for (const id of savedQueue.filter((item) => ID_RE.test(item))) this.storage.ensureJob('video', id);
    } catch { /* No pending sync work yet. */ }
    const recoveredVideos = this.storage.recoverJobs('video');
    for (const id of this.downloaded) this.storage.completeJob('video', id);
    this.queue = [...new Set(recoveredVideos.filter((id) => !this.downloaded.has(id)))];
    await this.saveQueue();
    try {
      const savedSubtitleQueue = this.storage.readJson<string[]>(this.subtitleQueuePath);
      for (const id of savedSubtitleQueue.filter((item) => ID_RE.test(item))) this.storage.ensureJob('subtitle', id);
    } catch { /* Subtitle work is queued after a video has completed. */ }
    const recoveredSubtitles = this.storage.recoverJobs('subtitle');
    this.subtitleQueue = [...new Set(recoveredSubtitles.filter((id) => this.downloaded.has(id)))];
    for (const id of recoveredSubtitles.filter((queuedId) => !this.downloaded.has(queuedId))) {
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
      this.reconcileTimer = setInterval(() => void this.reconcileDownloaded(), 5 * 60_000);
      this.reconcileTimer.unref?.();
      void this.scanBookmarkedChannelsOnStartup();
    }
  }

  async onModuleDestroy() {
    this.syncEnabled = false;
    if (this.reconcileTimer) { clearInterval(this.reconcileTimer); this.reconcileTimer = null; }
    if (this.downloadPumpTimer) { clearTimeout(this.downloadPumpTimer); this.downloadPumpTimer = null; }
    if (this.subtitlePumpTimer) { clearTimeout(this.subtitlePumpTimer); this.subtitlePumpTimer = null; }
    for (const id of this.active.keys()) this.storage.setJobPending('video', id);
    for (const id of this.activeSubtitleDownloads) this.storage.setJobPending('subtitle', id);
    await Promise.allSettled([this.queueWrite, this.subtitleQueueWrite, this.failureLogWrite]);
  }

  private async scanBookmarkedChannelsOnStartup() {
    if (!this.configuredDir) return;
    for (const channel of await this.channelService.getChannels()) {
      if (!channel.autoSync) continue;
      try {
        const videos = await this.channelService.scanChannel(channel.url);
        await this.enqueue(videos.map((v) => v.id));
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
    if (saved.cookiesBrowser && VideosService.COOKIE_BROWSERS.includes(saved.cookiesBrowser as typeof VideosService.COOKIE_BROWSERS[number])) {
      this.channelService.updateCookiesBrowser(saved.cookiesBrowser);
    }
    if (typeof saved.syncEnabled === 'boolean') this.syncEnabled = saved.syncEnabled;
    if (saved.language === 'en' || saved.language === 'nl') this.language = saved.language;
    return {
      downloadDir: this.configuredDir,
      downloadDirFixed: !!this.defaultDownloadDir,
      maxParallelDownloads: this.maxParallelDownloads,
      cookiesBrowser: this.channelService.cookiesBrowser,
      syncEnabled: this.syncEnabled,
      language: this.language,
    };
  }

  private settingsData(downloadDir: string | null) {
    return {
      downloadDir,
      maxParallelDownloads: this.maxParallelDownloads,
      cookiesBrowser: this.channelService.cookiesBrowser,
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
    this.channelService.updateCookiesBrowser(browser);
    await this.persist(this.settingsPath, this.settingsData(this.configuredDir));
    return this.getSettings();
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

  getChannels() { return this.channelService.getChannels(); }

  getSuggestions() { return this.channelService.getSuggestions(); }

  addChannel(channelUrl: string) { return this.channelService.addChannel(channelUrl); }

  removeChannel(channelUrl: string) { return this.channelService.removeChannel(channelUrl); }

  listChannel(channelUrl: string) { return this.channelService.listChannel(channelUrl); }

  async reorderChannels(urls: string[]) {
    const result = await this.channelService.reorderChannels(urls);
    await this.prioritizeQueue();
    await this.saveQueue();
    return result;
  }

  async setChannelAutoSync(channelUrl: string, enabled: boolean) {
    const channels = await this.channelService.setAutoSync(channelUrl, enabled);
    if (!enabled) return { channels, scanned: 0, queued: 0 };
    const videos = await this.channelService.scanChannel(channelUrl);
    await this.enqueue(videos.map((v) => v.id));
    const state = await this.getState();
    return { channels: await this.channelService.getChannels(), scanned: videos.length, queued: state.queued.length };
  }

  async getChannelVideoPage(url: string, offset = 0, limit = 20) {
    const bookmark = (await this.channelService.getChannels()).find((channel) => channel.url === url);
    if (!bookmark) throw new NotFoundException('Kanaalbookmark niet gevonden');
    const videos = await this.channelService.getCachedChannelVideos(url);
    if (!videos) {
      void this.channelService.scanChannel(url).then(async (vids) => {
        if (bookmark.autoSync) await this.enqueue(vids.map((v) => v.id));
      }).catch((error) => console.error(`Kanaalscan mislukt voor ${url}: ${String(error)}`));
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

  async getChannelProgress() {
    const channels = await this.channelService.getChannels();
    const downloaded = this.downloaded;
    const queued = new Set(this.queue);
    const active = new Map(this.active);
    const results = [];
    for (const channel of channels) {
      const videos = await this.channelService.getCachedChannelVideos(channel.url);
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
    const meta = this.storage.getVideoTitles([id]);
    const title = meta.get(id)?.title ?? id;
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

  private async prioritizeQueue() {
    if (this.queue.length < 2) return;
    const channels = await this.channelService.getChannels();
    const priority = new Map<string, number>();
    for (const [rank, channel] of channels.entries()) {
      const videos = await this.channelService.getCachedChannelVideos(channel.url);
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

  private hasSufficientDiskSpace(): boolean {
    if (!this.configuredDir) return true;
    try { const s = statfsSync(this.configuredDir); return s.bavail * s.bsize > 512 * 1024 * 1024; }
    catch { return true; }
  }

  private fsAccessible(dir: string): boolean {
    try { statfsSync(dir); return true; } catch { return false; }
  }

  getHealth() {
    const configOk = this.fsAccessible(this.dataDir);
    const downloadOk = this.configuredDir ? this.fsAccessible(this.configuredDir) : null;
    const dbOk = this.storage.isAlive();
    if (!configOk || !dbOk || downloadOk === false) {
      throw new ServiceUnavailableException({ status: 'degraded', checks: { config: configOk, downloads: downloadOk, database: dbOk } });
    }
    return { status: 'ok', checks: { config: configOk, downloads: downloadOk, database: dbOk } };
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

  async searchVideos(query: string, offset = 0, limit = 20) {
    if (!this.downloaded.size) return { items: [], total: 0, offset: 0, hasMore: false };
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const indexedMatches = new Set(this.storage.searchVideoIds(query));
    // Build the candidate set from the in-memory downloaded list + SQLite metadata.
    const dbMeta = this.storage.getVideosByIds([...this.downloaded]);
    // Fall back to readdir only for IDs present on disk but absent from the videos table (manually placed files).
    const uncatalogued = [...this.downloaded].filter((id) => !dbMeta.has(id));
    let extraVideos: VideoInfo[] = [];
    if (uncatalogued.length && this.configuredDir) {
      try {
        const files = await readdir(this.downloadDir);
        const fileMap = new Map(files.flatMap((f) => { const id = FILE_ID_RE.exec(f)?.[1]; return id ? [[id, f]] : []; }));
        extraVideos = uncatalogued.flatMap((id) => {
          const file = fileMap.get(id);
          if (!file) return [];
          const title = file.replace(/\s*\[[A-Za-z0-9_-]{11}\]\.[^.]+$/, '');
          const keywords = [...new Set(title.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
          return [{ id, title, thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, duration: null, keywords, keywordsEnglish: keywords, keywordsDutch: [] }];
        });
      } catch { /* Skip uncatalogued videos if the download directory is unavailable. */ }
    }
    const catalogued: VideoInfo[] = [...dbMeta.values()];
    const all = [...catalogued, ...extraVideos];
    const matches = all.filter((video) => {
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

  private async scanDownloadDir(): Promise<string[]> {
    if (!this.configuredDir) return [];
    const files = await readdir(this.downloadDir);
    return files.map((f) => FILE_ID_RE.exec(f)?.[1]).filter((id): id is string => !!id);
  }

  private async reconcileDownloaded() {
    try {
      const actual = new Set(await this.scanDownloadDir());
      for (const id of [...this.downloaded]) if (!actual.has(id)) this.downloaded.delete(id);
      for (const id of actual) if (!this.downloaded.has(id)) { this.downloaded.add(id); this.storage.completeJob('video', id); }
    } catch { /* Filesystem unavailable; keep the in-memory set as-is. */ }
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
      ...this.channelService.cookieArgs,
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
    const neededIds = [...new Set([...this.active.keys(), ...this.queue.slice(0, 8)])];
    const meta = this.storage.getVideoTitles(neededIds);
    const describe = (id: string, progress: number) => ({
      id,
      progress,
      title: meta.get(id)?.title ?? id,
      thumbnail: meta.get(id)?.thumbnail ?? `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    });
    const active = [...this.active.entries()].map(([id, data]) => describe(id, data.progress));
    const queuedItems = this.queue.slice(0, 8).map((id) => describe(id, 0));
    return {
      dir: this.configuredDir ?? '',
      downloaded: [...this.downloaded],
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
    for (const id of ids) {
      if (!ID_RE.test(id))
        throw new BadRequestException(`Ongeldig video-id: ${id}`);
      if (this.downloaded.has(id) || this.queue.includes(id) || this.active.has(id))
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
    if (!this.hasSufficientDiskSpace()) {
      console.warn('Onvoldoende vrije schijfruimte om te downloaden; opnieuw controleren over 1 minuut.');
      this.scheduleDownloadPump(60_000);
      return;
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
          this.downloaded.add(id);
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
            this.downloaded.add(id);
            this.storage.completeJob('video', id);
            this.queue = this.queue.filter((queuedId) => queuedId !== id);
          } else {
            this.rateLimitedDownloads.delete(id);
            if (this.downloaded.has(id)) {
              this.storage.completeJob('video', id);
              this.queue = this.queue.filter((queuedId) => queuedId !== id);
            } else {
              this.storage.setJobPending('video', id);
              if (!this.queue.includes(id)) this.queue.unshift(id);
            }
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

  private async run(id: string): Promise<boolean> {
    const { result, kill } = this.runner.run([
      '--no-playlist', '--newline',
      '--sleep-requests', '2',
      '--sleep-interval', '5',
      '--max-sleep-interval', '10',
      '--retries', '3',
      '--retry-sleep', 'http:exp=5:60',
      '-f', 'bv*[height<=1080]+ba/b[height<=1080]',
      '--merge-output-format', 'mp4',
      ...this.channelService.cookieArgs,
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
    const { ok, stderr, timedOut } = await result;
    this.downloadKills.delete(id);
    const reason = timedOut ? 'yt-dlp timeout overschreden' : 'yt-dlp sloot af met een fout';
    const rateLimited = /account has been rate-limited by YouTube|rate-limited.{0,40}(?:hour|minute)|HTTP Error 429|Too Many Requests/i.test(stderr);
    if (rateLimited) this.rateLimitedDownloads.add(id);
    if (!ok) this.downloadErrors.set(id, stderr || reason);
    this.persistedProgress.delete(id);
    if (!ok && !rateLimited && !this.pausedIds.has(id)) {
      try { await this.recordFailure(id, stderr || reason); }
      catch (error) { console.error(`Faallog opslaan mislukt voor ${id}: ${String(error)}`); }
    }
    return ok;
  }
}

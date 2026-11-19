import { Injectable } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

/** SQLite-backed storage and versioned, recoverable import of legacy JSON data. */
@Injectable()
export class AppStorage {
  readonly dataDir = resolve(process.env.APP_DATA_DIR || join(homedir(), '.youtubedownloader'));
  readonly databasePath = join(this.dataDir, 'library.db');
  private readonly database: DatabaseSync;
  private readonly legacyRoot = basename(this.dataDir) === 'config' ? dirname(this.dataDir) : null;

  constructor() {
    mkdirSync(this.dataDir, { recursive: true });
    const probe = join(this.dataDir, '.write-probe');
    try { writeFileSync(probe, ''); unlinkSync(probe); }
    catch (error) { throw new Error(`Config directory ${this.dataDir} is not writable — check that the volume is mounted with write access: ${String(error)}`); }
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.runMigrations();
    this.importLegacyFiles();
  }

  private runMigrations() {
    this.database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
    );`);
    const migrations = [
      {
        version: 1,
        name: 'sqlite-library-and-legacy-document-store',
        sql: `CREATE TABLE app_documents (path TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE data_imports (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, completed_at TEXT NOT NULL);
          CREATE TABLE videos (id TEXT PRIMARY KEY, title TEXT NOT NULL, thumbnail TEXT NOT NULL, duration INTEGER,
            keywords_english TEXT NOT NULL DEFAULT '[]', keywords_dutch TEXT NOT NULL DEFAULT '[]', keywords TEXT NOT NULL DEFAULT '[]');
          CREATE VIRTUAL TABLE videos_fts USING fts5(id UNINDEXED, title, keywords, tokenize='unicode61');
          CREATE TABLE channels (url TEXT PRIMARY KEY, title TEXT NOT NULL, added_at TEXT NOT NULL, auto_sync INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL);
          CREATE TABLE channel_videos (channel_url TEXT NOT NULL, video_id TEXT NOT NULL, position INTEGER NOT NULL, metadata TEXT NOT NULL,
            PRIMARY KEY(channel_url, video_id));
          CREATE TABLE job_state (name TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE jobs (id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL,
            PRIMARY KEY(kind, id));
          CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE error_events (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, message TEXT NOT NULL);
          CREATE INDEX error_events_created_at ON error_events(created_at);`,
      },
      {
        version: 2,
        name: 'durable-retryable-download-jobs',
        sql: `ALTER TABLE jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE jobs ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
          ALTER TABLE jobs ADD COLUMN next_attempt_at INTEGER;
          ALTER TABLE jobs ADD COLUMN last_error TEXT;
          ALTER TABLE jobs ADD COLUMN error_class TEXT;
          ALTER TABLE jobs ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;
          UPDATE jobs SET created_at = updated_at WHERE created_at = '';
          CREATE INDEX jobs_ready ON jobs(kind, status, next_attempt_at);`,
      },
    ];
    const applied = this.database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number };
    const latest = migrations.at(-1)!.version;
    if (applied.version > latest) throw new Error(`Data uses schema version ${applied.version}, but this image supports up to ${latest}. Restore the previous image or update the app.`);
    const existingMigrations = this.database.prepare('SELECT version, checksum FROM schema_migrations').all() as Array<{ version: number; checksum: string }>;
    for (const recorded of existingMigrations) {
      const definition = migrations.find((migration) => migration.version === recorded.version);
      if (definition && createHash('sha256').update(definition.sql).digest('hex') !== recorded.checksum) {
        throw new Error(`Migration history checksum mismatch at version ${recorded.version}; refusing to start against an altered database schema.`);
      }
    }
    if (applied.version > 0 && applied.version < latest) this.backupDatabase(applied.version, latest);
    for (const migration of migrations) {
      if (migration.version <= applied.version) continue;
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.database.exec(migration.sql);
        this.database.prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
          .run(migration.version, migration.name, checksum, new Date().toISOString());
        this.database.exec(`PRAGMA user_version = ${migration.version}`);
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw new Error(`Database migration ${migration.version} (${migration.name}) failed: ${String(error)}`);
      }
    }
  }

  private backupDatabase(fromVersion: number, toVersion: number) {
    const backupRoot = join(this.dataDir, 'migration-backups');
    const backup = join(backupRoot, `schema-${fromVersion}-to-${toVersion}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const stats = statfsSync(this.dataDir);
    if (stats.bavail * stats.bsize < statSync(this.databasePath).size * 2 + 16 * 1024 * 1024) {
      throw new Error('Not enough free space to safely back up the database before migration. Free disk space and restart.');
    }
    mkdirSync(backup, { recursive: true });
    const destination = join(backup, 'library.db');
    this.database.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
    writeFileSync(join(backup, 'BACKUP-MANIFEST.txt'), `Database backup created before schema migration ${fromVersion} -> ${toVersion}.\n`);
  }

  private importLegacyFiles() {
    const imported = this.database.prepare("SELECT 1 FROM data_imports WHERE name = 'legacy-json-v1'").get();
    if (imported) return;
    const files = this.getLegacyFiles();
    if (files.length) this.createLegacyBackup(files);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const file of files) {
        const contents = readFileSync(file.path, 'utf8');
        if (file.path.endsWith('.json')) JSON.parse(contents);
        this.database.prepare('INSERT OR IGNORE INTO app_documents(path, content, updated_at) VALUES (?, ?, ?)')
          .run(file.key, contents, new Date().toISOString());
        if (file.key === 'videos.json') this.indexVideos(contents);
        if (file.key === 'channels.json') this.indexChannels(contents);
      }
      this.indexChannelVideos(files);
      this.indexImportedSettingsAndJobs(files);
      const integrity = this.database.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (integrity.integrity_check !== 'ok') throw new Error(`SQLite integrity check returned ${integrity.integrity_check}`);
      for (const file of files) {
        if (!this.database.prepare('SELECT 1 FROM app_documents WHERE path = ?').get(file.key)) {
          throw new Error(`Imported document verification failed for ${file.key}`);
        }
        if (file.key === 'videos.json') {
          const expected = Object.keys(JSON.parse(readFileSync(file.path, 'utf8')) as Record<string, unknown>).length;
          const actual = (this.database.prepare('SELECT COUNT(*) AS count FROM videos').get() as { count: number }).count;
          if (actual !== expected) throw new Error(`Video count verification failed (expected ${expected}, got ${actual})`);
        }
        if (file.key === 'channels.json') {
          const expected = (JSON.parse(readFileSync(file.path, 'utf8')) as unknown[]).length;
          const actual = (this.database.prepare('SELECT COUNT(*) AS count FROM channels').get() as { count: number }).count;
          if (actual !== expected) throw new Error(`Channel count verification failed (expected ${expected}, got ${actual})`);
        }
      }
      this.database.prepare('INSERT INTO data_imports(name, checksum, completed_at) VALUES (?, ?, ?)')
        .run('legacy-json-v1', createHash('sha256').update(files.map((file) => file.key).join('\n')).digest('hex'), new Date().toISOString());
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw new Error(`Legacy data import failed; original files were preserved. Correct the invalid data or restore its backup and restart: ${String(error)}`);
    }
  }

  private findLegacyFiles(root: string): Array<{ path: string; key: string }> {
    const result: Array<{ path: string; key: string }> = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name === 'library.db' || entry.name.startsWith('library.db-') || entry.name === 'migration-backups' || entry.name.endsWith('.tmp')) continue;
      const path = join(root, entry.name);
      if (entry.isDirectory()) result.push(...this.findLegacyFiles(path));
      else if (/\.(json|log)$/.test(entry.name)) result.push({ path, key: relative(this.dataDir, path).split('\\').join('/') });
    }
    return result;
  }

  private getLegacyFiles() {
    const files = new Map<string, { path: string; key: string }>();
    if (this.legacyRoot) {
      const rootFiles = new Set(['settings.json', 'videos.json', 'channels.json', 'sync-queue.json', 'subtitle-queue.json', 'rate-limit.json', 'sync-failures.log']);
      for (const entry of readdirSync(this.legacyRoot, { withFileTypes: true })) {
        const path = join(this.legacyRoot, entry.name);
        if (entry.isFile() && rootFiles.has(entry.name)) files.set(entry.name, { path, key: entry.name });
        if (entry.isDirectory() && entry.name === 'channel-cache') {
          for (const cached of readdirSync(path, { withFileTypes: true })) {
            if (cached.isFile() && cached.name.endsWith('.json')) {
              files.set(`channel-cache/${cached.name}`, { path: join(path, cached.name), key: `channel-cache/${cached.name}` });
            }
          }
        }
      }
    }
    // If both layouts exist, files in config/ take precedence over the older root layout.
    for (const file of this.findLegacyFiles(this.dataDir)) files.set(file.key, file);
    return [...files.values()];
  }

  private createLegacyBackup(files: Array<{ path: string; key: string }>) {
    const backupRoot = join(this.dataDir, 'migration-backups');
    const backup = join(backupRoot, new Date().toISOString().replace(/[:.]/g, '-'));
    const bytes = files.reduce((total, file) => total + statSync(file.path).size, 0);
    const space = statfsSync(this.dataDir);
    if (space.bavail * space.bsize < bytes * 2 + 16 * 1024 * 1024) {
      throw new Error('Not enough free space to safely back up and import existing configuration data. Free disk space and restart.');
    }
    mkdirSync(backupRoot, { recursive: true });
    mkdirSync(backup, { recursive: true });
    for (const file of files) {
      const inConfig = file.path.startsWith(`${this.dataDir}/`);
      const destination = join(backup, inConfig ? 'config' : 'legacy-root', file.key);
      mkdirSync(resolve(destination, '..'), { recursive: true });
      copyFileSync(file.path, destination);
    }
    writeFileSync(join(backup, 'BACKUP-MANIFEST.txt'), `Created before first SQLite import. Original JSON and log files are preserved in the data folder.\nFiles: ${files.length}\n`);
  }

  private indexVideos(json: string) {
    const videos = JSON.parse(json) as Record<string, Record<string, unknown>>;
    const save = this.database.prepare(`INSERT INTO videos(id,title,thumbnail,duration,keywords_english,keywords_dutch,keywords)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, thumbnail=excluded.thumbnail,
      duration=excluded.duration, keywords_english=excluded.keywords_english, keywords_dutch=excluded.keywords_dutch, keywords=excluded.keywords`);
    const fts = this.database.prepare('INSERT INTO videos_fts(id,title,keywords) VALUES(?,?,?)');
    for (const [id, video] of Object.entries(videos)) {
      const english = JSON.stringify(video.keywordsEnglish ?? video.keywords ?? []);
      const dutch = JSON.stringify(video.keywordsDutch ?? []);
      const keywords = JSON.stringify(video.keywords ?? []);
      save.run(id, String(video.title ?? id), String(video.thumbnail ?? ''), typeof video.duration === 'number' ? video.duration : null, english, dutch, keywords);
      fts.run(id, String(video.title ?? id), Array.isArray(video.keywords) ? video.keywords.join(' ') : '');
    }
  }

  private indexChannels(json: string) {
    const channels = JSON.parse(json) as Array<{ url: string; title: string; addedAt: string; autoSync?: boolean }>;
    const save = this.database.prepare('INSERT INTO channels(url,title,added_at,auto_sync,position) VALUES(?,?,?,?,?)');
    channels.forEach((channel, position) => save.run(channel.url, channel.title, channel.addedAt, channel.autoSync === true ? 1 : 0, position));
  }

  private indexChannelVideos(files: Array<{ path: string; key: string }>) {
    const channelsFile = files.find((file) => file.key === 'channels.json');
    if (!channelsFile) return;
    const channels = JSON.parse(readFileSync(channelsFile.path, 'utf8')) as Array<{ url: string }>;
    const cacheFiles = new Map(files.filter((file) => file.key.startsWith('channel-cache/')).map((file) => [file.key, file]));
    const insert = this.database.prepare('INSERT INTO channel_videos(channel_url,video_id,position,metadata) VALUES(?,?,?,?)');
    for (const channel of channels) {
      const digest = createHash('sha256').update(channel.url).digest('hex');
      const cache = cacheFiles.get(`channel-cache/${digest}.json`);
      if (!cache) continue;
      const videos = JSON.parse(readFileSync(cache.path, 'utf8')) as Array<{ id: string }>;
      const seen = new Set<string>();
      videos.forEach((video, position) => {
        if (!/^[A-Za-z0-9_-]{11}$/.test(video.id) || seen.has(video.id)) return;
        seen.add(video.id);
        insert.run(channel.url, video.id, position, JSON.stringify(video));
      });
    }
  }

  private indexImportedSettingsAndJobs(files: Array<{ path: string; key: string }>) {
    const settings = files.find((file) => file.key === 'settings.json');
    if (settings) {
      const values = JSON.parse(readFileSync(settings.path, 'utf8')) as Record<string, unknown>;
      const insertSetting = this.database.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)');
      for (const [key, value] of Object.entries(values)) insertSetting.run(key, JSON.stringify(value), new Date().toISOString());
    }
    for (const [fileName, kind] of [['sync-queue.json', 'video'], ['subtitle-queue.json', 'subtitle']]) {
      const queueFile = files.find((file) => file.key === fileName);
      if (!queueFile) continue;
      const ids = JSON.parse(readFileSync(queueFile.path, 'utf8')) as string[];
      const insert = this.database.prepare('INSERT INTO jobs(id,kind,status,updated_at) VALUES(?,?,?,?)');
      [...new Set(ids.filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id)))].forEach((id) => insert.run(id, kind, 'pending', new Date().toISOString()));
    }
  }

  readJson<T>(path: string): T {
    const key = relative(this.dataDir, path).split('\\').join('/');
    const row = this.database.prepare('SELECT content FROM app_documents WHERE path = ?').get(key) as { content: string } | undefined;
    if (!row) throw new Error(`No stored data for ${key}`);
    return JSON.parse(row.content) as T;
  }

  writeJson(path: string, value: unknown) {
    const key = relative(this.dataDir, path).split('\\').join('/');
    const content = JSON.stringify(value, null, 2);
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`INSERT INTO app_documents(path,content,updated_at) VALUES(?,?,?)
        ON CONFLICT(path) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at`).run(key, content, now);
      if (key === 'videos.json') {
        this.database.exec('DELETE FROM videos; DELETE FROM videos_fts;');
        this.indexVideos(content);
      } else if (key === 'channels.json') {
        this.database.exec('DELETE FROM channels;');
        this.indexChannels(content);
        this.database.exec('DELETE FROM channel_videos;');
        this.indexStoredChannelVideos();
      } else if (key.startsWith('channel-cache/') && key.endsWith('.json')) {
        const digest = key.slice('channel-cache/'.length, -'.json'.length);
        const channel = (this.database.prepare('SELECT url FROM channels').all() as Array<{ url: string }>).find((entry) => createHash('sha256').update(entry.url).digest('hex') === digest);
        if (channel) {
          this.database.prepare('DELETE FROM channel_videos WHERE channel_url = ?').run(channel.url);
          const videos = JSON.parse(content) as Array<{ id: string }>;
          const insert = this.database.prepare('INSERT INTO channel_videos(channel_url,video_id,position,metadata) VALUES(?,?,?,?)');
          const seen = new Set<string>();
          videos.forEach((video, position) => {
            if (!/^[A-Za-z0-9_-]{11}$/.test(video.id) || seen.has(video.id)) return;
            seen.add(video.id);
            insert.run(channel.url, video.id, position, JSON.stringify(video));
          });
        }
      } else if (key === 'sync-queue.json' || key === 'subtitle-queue.json' || key === 'rate-limit.json') {
        this.database.prepare(`INSERT INTO job_state(name,content,updated_at) VALUES(?,?,?)
          ON CONFLICT(name) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at`).run(key, content, now);
        if (key.endsWith('-queue.json')) {
          const kind = key === 'sync-queue.json' ? 'video' : 'subtitle';
          const jobs = JSON.parse(content) as string[];
          const insert = this.database.prepare(`INSERT INTO jobs(id,kind,status,updated_at,created_at) VALUES(?,?,'pending',?,?)
            ON CONFLICT(kind,id) DO NOTHING`);
          jobs.forEach((id) => insert.run(id, kind, now, now));
        }
      } else if (key === 'settings.json') {
        this.database.exec('DELETE FROM app_settings;');
        const settings = JSON.parse(content) as Record<string, unknown>;
        const insert = this.database.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)');
        for (const [setting, value] of Object.entries(settings)) insert.run(setting, JSON.stringify(value), now);
      }
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  private indexStoredChannelVideos() {
    const channels = this.database.prepare('SELECT url FROM channels').all() as Array<{ url: string }>;
    const docs = this.database.prepare("SELECT path,content FROM app_documents WHERE path LIKE 'channel-cache/%.json'").all() as Array<{ path: string; content: string }>;
    const byPath = new Map(docs.map((doc) => [doc.path, doc.content]));
    const insert = this.database.prepare('INSERT INTO channel_videos(channel_url,video_id,position,metadata) VALUES(?,?,?,?)');
    for (const channel of channels) {
      const digest = createHash('sha256').update(channel.url).digest('hex');
      const json = byPath.get(`channel-cache/${digest}.json`);
      if (!json) continue;
      const seen = new Set<string>();
      (JSON.parse(json) as Array<{ id: string }>).forEach((video, position) => {
        if (!/^[A-Za-z0-9_-]{11}$/.test(video.id) || seen.has(video.id)) return;
        seen.add(video.id);
        insert.run(channel.url, video.id, position, JSON.stringify(video));
      });
    }
  }

  readText(path: string): string {
    const key = relative(this.dataDir, path).split('\\').join('/');
    const row = this.database.prepare('SELECT content FROM app_documents WHERE path = ?').get(key) as { content: string } | undefined;
    if (!row) throw new Error(`No stored data for ${key}`);
    return row.content;
  }

  getVideosByIds(ids: string[]): Map<string, { id: string; title: string; thumbnail: string; duration: number | null; keywords: string[]; keywordsEnglish: string[]; keywordsDutch: string[] }> {
    if (!ids.length) return new Map();
    const marks = ids.map(() => '?').join(',');
    const rows = this.database.prepare(`SELECT id,title,thumbnail,duration,keywords_english,keywords_dutch,keywords FROM videos WHERE id IN (${marks})`).all(...ids) as Array<{ id: string; title: string; thumbnail: string; duration: number | null; keywords_english: string; keywords_dutch: string; keywords: string }>;
    return new Map(rows.map((row) => [row.id, {
      id: row.id, title: row.title, thumbnail: row.thumbnail, duration: row.duration,
      keywords: JSON.parse(row.keywords) as string[],
      keywordsEnglish: JSON.parse(row.keywords_english) as string[],
      keywordsDutch: JSON.parse(row.keywords_dutch) as string[],
    }]));
  }

  getVideoTitles(ids: string[]): Map<string, { title: string; thumbnail: string }> {
    if (!ids.length) return new Map();
    const marks = ids.map(() => '?').join(',');
    const rows = this.database.prepare(`SELECT id, title, thumbnail FROM videos WHERE id IN (${marks})`).all(...ids) as Array<{ id: string; title: string; thumbnail: string }>;
    return new Map(rows.map((row) => [row.id, { title: row.title, thumbnail: row.thumbnail }]));
  }

  searchVideoIds(query: string): string[] {
    const terms = query.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
    if (!terms.length) return [];
    const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(' AND ');
    return (this.database.prepare('SELECT id FROM videos_fts WHERE videos_fts MATCH ?').all(expression) as Array<{ id: string }>).map((row) => row.id);
  }

  appendFailure(entry: string) {
    const row = this.database.prepare("SELECT content FROM app_documents WHERE path='sync-failures.log'").get() as { content: string } | undefined;
    const lines = `${row?.content ?? ''}${entry}`.split(/\r?\n/).filter(Boolean).slice(-1000);
    const content = `${lines.join('\n')}\n`;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`INSERT INTO app_documents(path,content,updated_at) VALUES('sync-failures.log',?,?)
        ON CONFLICT(path) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at`).run(content, new Date().toISOString());
      this.database.prepare('INSERT INTO error_events(created_at,message) VALUES(?,?)').run(new Date().toISOString(), entry.trim());
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  isAlive(): boolean {
    try { this.database.prepare('SELECT 1').get(); return true; } catch { return false; }
  }

  recoverJobs(kind: 'video' | 'subtitle'): string[] {
    this.database.prepare(`UPDATE jobs SET status='pending',updated_at=?,next_attempt_at=NULL
        ,progress=0 WHERE kind=? AND status='running'`).run(new Date().toISOString(), kind);
    return (this.database.prepare("SELECT id FROM jobs WHERE kind=? AND status IN ('pending','retry_wait') ORDER BY created_at,id")
      .all(kind) as Array<{ id: string }>).map((row) => row.id);
  }

  retryTimes(kind: 'video' | 'subtitle') {
    return this.database.prepare("SELECT id,next_attempt_at FROM jobs WHERE kind=? AND status='retry_wait' AND next_attempt_at IS NOT NULL")
      .all(kind) as Array<{ id: string; next_attempt_at: number }>;
  }

  ensureJob(kind: 'video' | 'subtitle', id: string) {
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO jobs(id,kind,status,updated_at,created_at) VALUES(?,?,'pending',?,?)
      ON CONFLICT(kind,id) DO NOTHING`).run(id, kind, now, now);
  }

  setJobPending(kind: 'video' | 'subtitle', id: string) {
    const now = new Date().toISOString();
    this.database.prepare(`UPDATE jobs SET status='pending',updated_at=?,next_attempt_at=NULL,last_error=NULL,error_class=NULL,progress=0 WHERE kind=? AND id=?`)
      .run(now, kind, id);
  }

  jobNextAttemptAt(kind: 'video' | 'subtitle', id: string): number | null {
    const row = this.database.prepare('SELECT next_attempt_at FROM jobs WHERE kind=? AND id=?').get(kind, id) as { next_attempt_at: number | null } | undefined;
    return row?.next_attempt_at ?? null;
  }

  jobAttemptCount(kind: 'video' | 'subtitle', id: string): number {
    const row = this.database.prepare('SELECT attempt_count FROM jobs WHERE kind=? AND id=?').get(kind, id) as { attempt_count: number } | undefined;
    return row?.attempt_count ?? 0;
  }

  resetJob(kind: 'video' | 'subtitle', id: string) {
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO jobs(id,kind,status,updated_at,created_at) VALUES(?,?,'pending',?,?)
      ON CONFLICT(kind,id) DO UPDATE SET status='pending',updated_at=excluded.updated_at,attempt_count=0,
        next_attempt_at=NULL,last_error=NULL,error_class=NULL,progress=0`).run(id, kind, now, now);
  }

  startJob(kind: 'video' | 'subtitle', id: string) {
    this.database.prepare(`UPDATE jobs SET status='running',attempt_count=attempt_count+1,updated_at=?,next_attempt_at=NULL,progress=0
      WHERE kind=? AND id=?`).run(new Date().toISOString(), kind, id);
  }

  updateJobProgress(id: string, progress: number) {
    this.database.prepare("UPDATE jobs SET progress=?,updated_at=? WHERE kind='video' AND id=? AND status='running'")
      .run(progress, new Date().toISOString(), id);
  }

  completeJob(kind: 'video' | 'subtitle', id: string) {
    this.database.prepare(`UPDATE jobs SET status='completed',progress=100,updated_at=?,next_attempt_at=NULL,last_error=NULL,error_class=NULL
      WHERE kind=? AND id=?`).run(new Date().toISOString(), kind, id);
  }

  failJob(kind: 'video' | 'subtitle', id: string, status: 'failed' | 'skipped', error: string, errorClass: string) {
    this.database.prepare('UPDATE jobs SET status=?,updated_at=?,next_attempt_at=NULL,last_error=?,error_class=? WHERE kind=? AND id=?')
      .run(status, new Date().toISOString(), error.slice(-8000), errorClass, kind, id);
  }

  retryJob(kind: 'video' | 'subtitle', id: string, nextAttemptAt: number, error: string, errorClass: string) {
    this.database.prepare(`UPDATE jobs SET status='retry_wait',updated_at=?,next_attempt_at=?,last_error=?,error_class=?,progress=0
      WHERE kind=? AND id=?`).run(new Date().toISOString(), nextAttemptAt, error.slice(-8000), errorClass, kind, id);
  }

  jobsByStatus(kind: 'video' | 'subtitle', statuses: string[]) {
    const marks = statuses.map(() => '?').join(',');
    return this.database.prepare(`SELECT id,status,attempt_count,created_at,updated_at,next_attempt_at,last_error,error_class,progress
      FROM jobs WHERE kind=? AND status IN (${marks}) ORDER BY created_at DESC`).all(kind, ...statuses) as Array<{
        id: string; status: string; attempt_count: number; created_at: string; updated_at: string;
        next_attempt_at: number | null; last_error: string | null; error_class: string | null; progress: number;
      }>;
  }
}

# Architecture Improvement Proposals

This document tracks reliability, performance, and fault-recovery improvements. Items below identify which foundations have been implemented and which follow-up work remains.

## Context and design direction

The application currently runs as a local, single-user Docker app. Optimize for dependable operation on one computer before introducing distributed infrastructure. Keep videos and subtitles as files, and use a small embedded database for application data and work state.

## Prioritized improvements

### 1. Store application data in SQLite — foundation implemented

The app now uses `/app-data/config/library.db` for its JSON-shaped settings, channel data, queues, cached channel results, failure log, and video catalog. It also maintains normalized video and channel tables, a durable job-state table, an error-event table, schema history, and an FTS5 index over video titles and English/Dutch keywords. Actual video and subtitle files remain under `/app-data/downloads`.

- Writes to the database and its search index use transactions. Versioned migrations include checksums, run before the API starts, and reject unknown future versions or modified migration history.
- On first startup, JSON configuration in `config/` and legacy JSON at the mounted `app-data/` root are backed up and imported transactionally. Source files are not deleted. Import validation checks JSON, imported documents, and SQLite integrity before recording completion.
- The FTS5 index is maintained as video metadata changes and is used to find indexed video matches. Some results may still use the file-based fallback until the catalog is fully normalized. [SQLite FTS5 documentation](https://www.sqlite.org/fts5.html)
- Each future schema upgrade makes a timestamped `VACUUM INTO` backup before applying changes. Database backups and first-import file backups are stored under `config/migration-backups/`.

### 2. Make download and subtitle jobs durable and recoverable — core implemented

Video and subtitle work now has durable per-video jobs with explicit `pending`, `running`, `retry_wait`, `completed`, `failed`, or `skipped` states. The version 2 database migration adds attempts, retry time, progress, error details, and error category; it creates a database backup before upgrading. A running job returns to the queue after restart. Video downloads and subtitle fetches retain independent jobs and failure handling.

Queue insertion is idempotent. Temporary network failures and YouTube rate limits use bounded retries with exponential delay and jitter. Permanent access failures are recorded as skipped or failed and are not automatically requeued by channel auto-sync. Selecting a failed video for a manual download explicitly resets its job. The sync page shows retry countdowns for videos and the number of subtitle jobs waiting to retry.

Follow-up work: show richer error details in the UI, review error classification against real yt-dlp logs, and add automated restart/retry recovery checks to CI.

### 3. Centralize yt-dlp process management and error handling — implemented

A single `YtdlpRunner` service (injected into `VideosService`) now handles all four yt-dlp call sites: channel listing, metadata enrichment, video downloads, and subtitle downloads. It owns the binary path, tracks every active child process, and exposes `killAll()` via `OnModuleDestroy` for clean shutdown.

The runner provides one `run(args, opts)` method. Stderr is bounded by a configurable byte limit. Stdout can be streamed line-by-line (enrichment), buffered (channel listing), or tracked for progress percentages (video downloads). Every call returns a typed `kill()` function; download kills are stored per video-id so sync-pause can stop only active downloads. Error classification (`classifyError`) lives in the runner and covers rate limits, permanent access failures, temporary 403s, transient network errors, and non-retryable failures — consistent across all job types.

### 4. Reduce repeated file and catalog work — implemented

The state endpoint is no longer I/O-bound on each two-second poll. An in-memory `downloaded: Set<string>` is populated with one `readdir` scan at startup and updated incrementally as downloads complete. `getState()` reads from this set and performs a single targeted SQLite query (`getVideoTitles`) for the small set of active and queued video IDs, replacing a full catalog JSON load. `enqueue()` and `getChannelProgress()` also use the in-memory set.

A background timer reconciles the in-memory set with the actual download folder every five minutes, so externally deleted files are detected without blocking the state poll. `searchVideos()` queries the SQLite `videos` table for downloaded IDs and falls back to `readdir` only for the rare case of uncatalogued manually placed files. Metadata enrichment is capped at two concurrent yt-dlp processes.

Follow-up work: return a compact state snapshot or changes since a cursor; consider server-sent events if polling remains a bottleneck at larger collection sizes.

### 5. Stream large channel scans — implemented

`listChannel` now processes yt-dlp JSON lines incrementally using the runner's `onLine` streaming mode instead of accumulating all stdout in a string. Slim `VideoInfo` objects are collected as lines arrive (roughly 100× smaller than the raw yt-dlp JSON per video). Metadata is flushed to the database in batches of 50, so videos processed before an early exit are not lost. The full collected list is still returned to the caller after the stream ends.

### 6. Validate storage and support graceful shutdown — implemented

`AppStorage` writes a probe file before opening the database; a read-only or missing mount now produces a clear error message instead of a cryptic SQLite failure. `VideosService` implements `OnModuleDestroy`: timers are stopped, active video and subtitle jobs are marked `pending` so they recover on the next start, and pending queue and log writes are awaited before the process exits. `main.ts` enables NestJS shutdown hooks so SIGTERM is handled cleanly. `YtdlpRunner.onModuleDestroy` already kills all active child processes.

The download pump checks for at least 512 MB of free space before starting each slot; if space is low it reschedules after one minute rather than starting a download that would likely fail mid-way.

`GET /api/health` returns `{ status, checks: { config, downloads, database } }`. It uses `statfsSync` to confirm the config and download filesystems are reachable and a `SELECT 1` to confirm the database is responsive. The endpoint returns 503 when any check fails. Both Dockerfiles now include a `HEALTHCHECK` that calls this endpoint via Node's built-in `fetch` every 30 seconds.

### 7. Split the backend into focused services — implemented

The 1099-line `VideosService` has been split into two focused services:

- **`ChannelService`** (327 lines) — owns channel bookmarks and CRUD, channel scans, `listChannel` streaming, background metadata enrichment, video catalog saves, Dutch keyword translation, `searchVideos`, and cookie configuration. It is independently injectable and testable without the download queue.
- **`VideosService`** (821 lines) — owns settings, download job orchestration, subtitle job orchestration, state/health, and lifecycle. It injects `ChannelService` and delegates channel-facing controller routes to it, while handling orchestration concerns such as enqueuing after a scan or reprioritizing the queue after a channel reorder.

The two pre-existing services remain: `YtdlpRunner` (spawning and process lifecycle) and `AppStorage` (SQLite and migrations).

Key design decisions: `ChannelService` holds cookie config state directly (env vars + `updateCookiesBrowser` for runtime updates). Methods that cross both concerns — `setChannelAutoSync`, `getChannelVideoPage`, `reorderChannels` — stay in `VideosService` as orchestration. No circular dependencies between the services.

### 8. Strengthen release checks and operational visibility — implemented

**CI and release gates:** A reusable `checks.yml` workflow runs the backend TypeScript check, backend build, frontend build, and a container smoke test (builds the backend Docker image and verifies the API responds within 50 s). `ci.yml` triggers these checks on every push to non-main branches and on pull requests. `publish-docker.yml` runs the same checks before publishing, so a broken build can never reach the registry.

**yt-dlp version pinning:** Both Dockerfiles now install a specific yt-dlp version via `ARG YTDLP_VERSION=<date>`. An `update-ytdlp.yml` workflow runs every Monday: it fetches the latest version from PyPI and opens a pull request to bump the ARG in both Dockerfiles when a new release is available. This keeps builds reproducible while allowing deliberate, reviewed updates.

**Health endpoint enhancements:** `GET /api/health` now includes:
- `checks.ytdlp` — whether the yt-dlp binary exists at the configured path
- `queue` — current counts for `queued`, `active`, and `failed` download jobs
- `lastSyncAt` — ISO timestamp of the most recently completed video download (from the jobs table), or `null` if none

Follow-up work: add queue-recovery tests using a temporary data directory and a fake yt-dlp process; add structured JSON log lines for the key failure events.

## Suggested implementation sequence

1. Add queue and recovery tests using a temporary data directory and a fake yt-dlp process.
2. Add startup storage validation, graceful shutdown, and bounded yt-dlp output handling.
3. Normalize channel-video relationships and queue jobs fully into relational tables; currently compatibility documents are also retained in SQLite.
4. Move video and subtitle queues into SQLite and add error-specific retry policies.
5. Move catalog pagination and search onto indexed database queries; add bounded channel streaming.
6. Split the large service and add CI checks and container health reporting.

## Queue infrastructure trade-off

For the current single-container desktop setup, a SQLite-backed job table is likely simpler to install, back up, and restore than Redis. If the application later needs multiple independent worker containers, BullMQ is a viable option, but it requires Redis and adds another service to deploy and maintain. NestJS documents BullMQ support, persisted jobs, priorities, delayed jobs, and separate worker processes in its [queue documentation](https://docs.nestjs.com/application/queues).

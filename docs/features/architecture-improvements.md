# Architecture Improvement Proposals

This document records proposed improvements for reliability, performance, and fault recovery. It describes recommendations only; it does not imply that they have been implemented.

## Context and design direction

The application currently runs as a local, single-user Docker app. Optimize for dependable operation on one computer before introducing distributed infrastructure. Keep videos and subtitles as files, and use a small embedded database for application data and work state.

## Prioritized improvements

### 1. Move application data from JSON files to SQLite

Use one SQLite database under `/app-data/config` for video metadata, channel bookmarks, settings, failure records, and job state. Keep the actual video and subtitle files under `/app-data/downloads`.

- Use transactions for related updates so a crash cannot leave the catalog and queue out of sync.
- Add schema migrations and make them safe to run at startup.
- Import existing JSON files during migration, preserve the originals, and create a backup before changing data.
- Add an FTS5 index for English and Dutch keywords so collection searches and paged results do not require loading the full catalog into memory. [SQLite FTS5 documentation](https://www.sqlite.org/fts5.html)

### 2. Make download and subtitle jobs durable and recoverable

Store each video download and subtitle fetch as a job with a stable ID and explicit state, such as `pending`, `running`, `retry_wait`, `completed`, `failed`, or `skipped`.

Record attempt count, last error category, creation and update times, and the next eligible retry time. At startup, return jobs left in `running` to a retryable state. Use idempotent job creation so rescanning a channel cannot add duplicate work. Keep video and subtitle jobs independent.

### 3. Centralize yt-dlp process management and error handling

Use one process runner for channel scans, metadata enrichment, video downloads, and subtitle downloads. It should:

- Capture progress and bounded diagnostic output without accumulating unbounded strings.
- Apply timeouts, handle termination signals, and clean up child processes during shutdown.
- Classify errors into transient network failures, YouTube rate limits, access restrictions, unavailable or removed videos, and local storage failures.
- Retry only recoverable errors with capped exponential backoff and jitter; honor server retry guidance when available.
- Keep permanent failures out of automatic retry loops while retaining enough diagnostic detail for the failure log.

Treat HTTP 403 as an ambiguous error. It can indicate a temporary YouTube restriction or a version, network, or access problem, so do not apply an unlimited retry policy.

### 4. Reduce repeated file and catalog work

The current state endpoint reads and parses the video catalog, while downloaded-video checks scan the download directory. The frontend polls state every two seconds, so this work repeats frequently as the collection grows.

- Serve overview and search results with database-backed pagination and indexes.
- Keep download status in the database and reconcile it with files at startup and periodically, rather than scanning the entire folder for every poll.
- Return a compact state snapshot or changes since a cursor. Consider server-sent events later if polling becomes a measurable bottleneck.
- Add limits to concurrent channel scans and metadata enrichment.

### 5. Stream large channel scans

Channel-list output is currently accumulated before it is parsed. Process yt-dlp JSON lines incrementally and save results in batches. This bounds memory use for channels with large histories and reduces the risk of oversized-string failures.

### 6. Validate storage and support graceful shutdown

At startup, confirm that `/app-data/config` and `/app-data/downloads` are writable and report a clear health state if the mount is missing or read-only. Check available disk space before starting large downloads.

On shutdown, stop accepting new work, terminate child processes cleanly, persist active jobs as recoverable, and flush pending database writes. Add a Docker health check that verifies the API and storage are ready, rather than checking only that the container process exists. [Docker `HEALTHCHECK` documentation](https://docs.docker.com/reference/dockerfile/#healthcheck)

### 7. Split the backend into focused services

`VideosService` currently coordinates catalog storage, channel scans, queues, yt-dlp processes, subtitles, failure logs, and sync state. Separate those responsibilities into focused components, for example:

- Video catalog and search
- Channel bookmarks and scans
- Download job orchestration
- Subtitle job orchestration
- yt-dlp process runner
- Storage and migrations

This makes failures easier to isolate and lets each component be tested without running the complete app.

### 8. Strengthen release checks and operational visibility

Before a Docker image is published, run backend and frontend checks, queue-recovery tests, and a container smoke test. Add structured logs with video ID, channel, job ID, attempt number, and error category. Provide health information for storage, yt-dlp availability, queue sizes, and the most recent successful sync.

Pin the yt-dlp version used in each image build, then update it through a deliberate scheduled or reviewed workflow. This makes releases reproducible while still allowing timely updates when YouTube changes.

## Suggested implementation sequence

1. Add queue and recovery tests using a temporary data directory and a fake yt-dlp process.
2. Add startup storage validation, graceful shutdown, and bounded yt-dlp output handling.
3. Introduce SQLite with migrations and import the existing JSON data without deleting the originals.
4. Move video and subtitle queues into SQLite and add error-specific retry policies.
5. Move catalog pagination and search onto indexed database queries; add bounded channel streaming.
6. Split the large service and add CI checks and container health reporting.

## Queue infrastructure trade-off

For the current single-container desktop setup, a SQLite-backed job table is likely simpler to install, back up, and restore than Redis. If the application later needs multiple independent worker containers, BullMQ is a viable option, but it requires Redis and adds another service to deploy and maintain. NestJS documents BullMQ support, persisted jobs, priorities, delayed jobs, and separate worker processes in its [queue documentation](https://docs.nestjs.com/application/queues).

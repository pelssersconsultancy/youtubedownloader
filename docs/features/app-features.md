# App features and requirements

This file is the durable product requirements list for the downloader frontend and collection.

## Startup and storage location

- On first startup, require the user to configure the folder where downloaded videos are stored.
- Persist the selected folder on the backend so it remains configured after restarting the app.
- Let the user change the folder later through a settings gear in the interface.
- Store the setting outside the project folder.
- Let the user choose English or Dutch in settings; default to English and persist the choice with the other application settings.

## Video collection and metadata

- When importing a channel or playlist, persist metadata for every video in the collection.
- Store useful per-video keywords so the user can search across the complete imported collection.
- Support collecting available title, tag, category, and description terms without downloading video media during metadata import.
- Store source-language and Dutch keywords for each video so searches work with both English and Dutch terms.
- Use DeepL keyword translation when `DEEPL_AUTH_KEY` is configured; retain source keywords if translation is unavailable.
- Keep metadata import behavior maintainable by the `collect-metadata` Claude Code agent.
- Keep the project usable with Claude Code.
- Prefer SQLite with full-text search (FTS5) for the durable collection as it grows; keep the download-folder setting separate.

## Navigation and overview

- Use a futuristic visual style inspired by dark navy, electric blue and magenta gradients, technical grid details, and luminous controls while keeping text legible.
- Provide a navigation bar on the left.
- Open the overview page by default.
- Display only videos already downloaded to the configured folder in the overview, 20 at a time.
- Load the next 20 saved videos as the user scrolls, using virtualized rendering so only the visible window of rows is rendered.
- Allow searching the complete saved collection by keywords.
- Present overview videos as video cards rather than the channel-import selection list; omit download checkboxes and download status there.
- Make overview video cards show a pointer cursor and a slightly darker background on hover.
- Open a player for a downloaded local video when its overview card is clicked.
- Download available English and Dutch manual or auto-generated subtitles in a separate persistent queue so subtitle failures never fail video downloads; retry YouTube HTTP 429 rate limits with increasing delays while keeping the job queued, and space out subtitle requests. Serve subtitles as WebVTT tracks and automatically show the track matching the persisted app language. Fetch missing subtitle sidecars on first playback for videos already downloaded.
- Space YouTube extraction and video requests by 5–10 seconds; when YouTube reports an account rate limit, keep the video queued, persist an approximately one-hour cooldown across restarts, and show the retry delay in Sync progress instead of recording a permanent failure.

## Channel bookmarks and synchronization

- Add a **My Channels** navigation item below **Overview** and show saved channel bookmarks there; omit a separate channel-import navigation item.
- Add a **Suggestions** page below **My Channels**, backed by `docs/skills/suggestions.json`, grouping verified YouTube channels under the main sections and subsections from the self-reliance skills guide. Each suggestion can be added to My Channels; adding it does not enable auto-sync.
- Add a separate **Sync progress** navigation item below **Suggestions** and show sync progress grouped by channel on that page.
- After adding a channel, keep the user on the My Channels page and show the new channel in the bookmark list.
- Keep Sync progress off the Kanalen page itself.
- Let the user click a bookmarked channel to open its video selection page, show the channel title at the top, and load its videos automatically without a URL field or load button.
- Load bookmarked-channel details from a local per-channel cache in pages of 20 and virtualize the list; fetch further pages as the user scrolls so cached first results appear immediately.
- Auto-sync is an explicit per-channel toggle, off by default. The add action only bookmarks the channel.
- Let the user drag bookmarked channels to reorder them; show clear instructions for using the drag handle.
- Give channels higher in the saved order priority over lower channels when queuing pending syncs; do not interrupt already-running downloads.
- When auto-sync is enabled, scan the channel and enqueue every video that is not already downloaded.
- Exclude YouTube entries whose yt-dlp availability is `subscriber_only` (members-only) from channel caches and sync queues.
- On backend startup, rescan only channels with auto-sync enabled and enqueue newly available videos.
- Run each video synchronization in its own `yt-dlp` process.
- Let the user configure the maximum number of parallel video sync processes in settings; default to 1.
- Poll sync status every 2 seconds and show active video titles, thumbnails, and download progress, plus a preview of queued videos.
- Show a Faal log link next to the Sync progress title; open the latest 1,000 failure-log lines in a closable scrollable dialog.
- Use yt-dlp browser cookies from the selected browser for metadata scans and downloads.
- Provide Stop syncing / Start syncing controls; stopping terminates active download processes and retains their jobs in the persistent queue for resuming.

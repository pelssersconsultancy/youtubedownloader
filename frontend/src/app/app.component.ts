import { Component, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, catchError, interval, startWith, switchMap } from 'rxjs';

interface Video {
  id: string;
  title: string;
  thumbnail: string;
  duration: number | null;
  keywords: string[];
}
interface Settings {
  downloadDir: string | null;
  downloadDirFixed?: boolean;
  maxParallelDownloads: number;
  cookiesBrowser: string;
  syncEnabled: boolean;
  language: 'en' | 'nl';
}
interface Channel {
  url: string;
  title: string;
  addedAt: string;
  autoSync: boolean;
}
interface Suggestion {
  title: string;
  url: string;
  verified: boolean;
}
interface SuggestionSubsection {
  title: string;
  channels: Suggestion[];
}
interface SuggestionSection {
  title: string;
  subsections: SuggestionSubsection[];
}
interface VideoPage {
  items: Video[];
  total: number;
  offset: number;
  hasMore: boolean;
  scanning?: boolean;
}
interface SyncVideo {
  id: string;
  title: string;
  thumbnail: string;
  progress: number;
}
interface ChannelSyncProgress extends Channel {
  total: number;
  completed: number;
  active: SyncVideo[];
  queued: Video[];
  failed: Video[];
  percent: number;
  scanning: boolean;
}
interface State {
  dir: string;
  downloaded: string[];
  queued: string[];
  current: SyncVideo | null;
  active?: SyncVideo[];
  queuedItems?: SyncVideo[];
  syncEnabled: boolean;
  retryAt?: number | null;
  failed: string[];
}

const API = '/api';

@Component({
  selector: 'app-root',
  standalone: true,
  template: `
    <div class="layout">
      <aside class="sidebar" aria-label="Hoofdnavigatie">
        <div class="brand">{{ t('Survival library', 'Overlevings Bibliotheek') }}</div>
        <button
          type="button"
          class="nav-item"
          [class.active]="page() === 'overview'"
          (click)="openPage('overview')"
        >
          ▦ <span>{{ t('Overview', 'Overzicht') }}</span>
        </button>
        <button
          type="button"
          class="nav-item"
          [class.active]="page() === 'channels'"
          (click)="openPage('channels')"
        >
          ▤ <span>{{ t('My Channels', 'Mijn kanalen') }}</span>
        </button>
        <button
          type="button"
          class="nav-item"
          [class.active]="page() === 'suggestions'"
          (click)="openPage('suggestions')"
        >
          ✧ <span>{{ t('Suggestions', 'Suggesties') }}</span>
        </button>
        <button
          type="button"
          class="nav-item"
          [class.active]="page() === 'sync-progress'"
          (click)="openPage('sync-progress')"
        >
          ◴ <span>{{ t('Sync progress', 'Syncvoortgang') }}</span>
        </button>
      </aside>
      <main>
        <header>
          @if (page() === 'sync-progress') {
            <div class="title-tools">
              <h1>{{ t('Sync progress', 'Syncvoortgang') }}</h1>
              <button type="button" class="log-link" (click)="openFailureLog()">
                {{ t('Failure log', 'Faallog') }}
              </button>
            </div>
          } @else {
            <h1>
              {{
                page() === 'overview'
                  ? t('Overview', 'Overzicht')
                  : page() === 'channels'
                    ? t('My Channels', 'Mijn kanalen')
                    : page() === 'suggestions'
                      ? t('Suggestions', 'Suggesties')
                      : (selectedChannel()?.title ?? t('Channel', 'Kanaal'))
              }}
            </h1>
          }
          @if (state().dir) {
            <p class="dir">{{ t('Saving to', 'Opslaan in') }} {{ state().dir }}</p>
          }
          <button
            type="button"
            class="settings"
            [attr.aria-label]="t('Open settings', 'Instellingen openen')"
            [attr.title]="t('Settings', 'Instellingen')"
            (click)="settingsOpen.set(!settingsOpen())"
          >
            ⚙
          </button>
        </header>

        @if (settingsLoaded() && (!state().dir || settingsOpen())) {
          <section class="setup">
            <h2>
              {{
                state().dir
                  ? t('Settings', 'Instellingen')
                  : t('Choose a storage folder', 'Kies een opslagmap')
              }}
            </h2>
            <p>
              @if (storageLocationFixed()) {
                {{
                  t(
                    'The video folder is set in Docker Desktop. Container path: /app-data/downloads. To change the host folder, update the volume mapping in Docker Desktop.',
                    'De videomap is ingesteld in Docker Desktop. Containerpad: /app-data/downloads. Wijzig de volumekoppeling in Docker Desktop om de map op je computer te veranderen.'
                  )
                }}
              } @else {
                {{
                  t(
                    'Enter the full path to the folder where you want to save videos.',
                    'Vul het volledige pad in van de map waarin je video’s wilt bewaren.'
                  )
                }}
              }
            </p>
            <form class="bar" (submit)="$event.preventDefault(); saveFolder()">
              @if (!storageLocationFixed()) {
                <input
                  type="text"
                  [placeholder]="
                    t(
                      'For example /Users/name/Movies/YouTube',
                      'Bijvoorbeeld /Users/naam/Movies/YouTube'
                    )
                  "
                  [value]="folderPath()"
                  (input)="folderPath.set($any($event.target).value)"
                />
              }
              <button type="submit" [disabled]="savingFolder() || (!storageLocationFixed() && !folderPath().trim())">
                {{
                  savingFolder()
                    ? t('Saving…', 'Opslaan…')
                    : t('Save settings', 'Instellingen opslaan')
                }}
              </button>
              @if (state().dir) {
                <button type="button" class="ghost" (click)="settingsOpen.set(false)">
                  {{ t('Cancel', 'Annuleren') }}
                </button>
              }
            </form>
            <label class="setting-field"
              >{{ t('Language', 'Taal') }}
              <select [value]="language()" (change)="language.set($any($event.target).value)">
                <option value="en">English</option>
                <option value="nl">Nederlands</option>
              </select>
            </label>
            <label class="setting-field"
              >{{ t('Parallel video syncs', 'Gelijktijdige video-synchronisaties') }}
              <input
                type="number"
                min="1"
                max="8"
                [value]="maxParallelDownloads()"
                (input)="maxParallelDownloads.set(+$any($event.target).value)"
              />
            </label>
            <label class="setting-field"
              >{{ t('Browser for YouTube sign-in', 'Browser voor YouTube-login') }}
              <select
                [value]="cookiesBrowser()"
                (change)="cookiesBrowser.set($any($event.target).value)"
              >
                <option value="chrome">Google Chrome</option>
                <option value="chromium">Chromium</option>
                <option value="safari">Safari</option>
                <option value="firefox">Firefox</option>
                <option value="edge">Microsoft Edge</option>
                <option value="brave">Brave</option>
                <option value="opera">Opera</option>
                <option value="vivaldi">Vivaldi</option>
                <option value="whale">Whale</option>
              </select>
            </label>
            <p class="setting-hint">
              {{
                t(
                  'Choose the browser where you are signed in to YouTube. yt-dlp reads its cookies.',
                  'Kies dezelfde browser waarin je op YouTube bent ingelogd. yt-dlp leest daar de cookies uit.'
                )
              }}
            </p>
          </section>
        } @else if (settingsLoaded() && page() === 'overview') {
          <section class="hero-banner">
            <div class="hero-copy">
              <span class="eyebrow">{{
                t('PERSONAL VIDEO ARCHIVE', 'PERSOONLIJK VIDEOARCHIEF')
              }}</span>
              <h2>
                {{ t('Your collection,', 'Jouw collectie,') }}<br /><span>{{
                  t('in motion.', 'in beweging.')
                }}</span>
              </h2>
              <p>
                {{
                  t(
                    'One place for every story you have saved.',
                    'Alle video’s die je hebt bewaard, op één plek.'
                  )
                }}
              </p>
            </div>
            <div class="hero-orbit" aria-hidden="true">
              <div class="orbit-core">▶</div>
              <i></i><b></b><em></em><span></span>
            </div>
            <div class="hero-index">
              <span>{{ t('LIBRARY INDEX', 'COLLECTIE-INDEX') }}</span><strong>{{
                totalVideos()
              }}</strong
              ><small>{{ t('VIDEOS', 'VIDEO’S') }}</small>
            </div>
          </section>
          <div class="bar tools">
            <input
              type="search"
              [placeholder]="t('Search your collection', 'Zoek in je collectie')"
              [value]="query()"
              (input)="searchCollection($any($event.target).value)"
            />
          </div>
          <p class="count">
            {{ totalVideos() }} {{ t('downloaded videos', 'gedownloade video’s') }}
          </p>
          <div class="video-scroll" (scroll)="onVideoScroll($event)">
            <ul>
              @if (virtualStart() > 0) {
                <li class="spacer" [style.height.px]="virtualStart() * rowHeight"></li>
              }
              @for (v of visibleVideos(); track v.id) {
                <li class="video-row">
                  <article
                    class="video-card"
                    role="button"
                    tabindex="0"
                    (click)="playVideo(v)"
                    (keydown.enter)="playVideo(v)"
                    (keydown.space)="playVideo(v); $event.preventDefault()"
                  >
                    <img [src]="v.thumbnail" alt="" loading="lazy" width="180" height="102" />
                    <div class="video-info">
                      <h2>{{ v.title }}</h2>
                      @if (v.duration != null) {
                        <p class="dur">{{ fmt(v.duration) }}</p>
                      }
                      <p class="keywords">{{ v.keywords.slice(0, 8).join(' · ') }}</p>
                    </div>
                  </article>
                </li>
              } @empty {
                @if (!loadingMore()) {
                  <li class="empty">
                    {{
                      t(
                        'No videos have been downloaded yet.',
                        'Er zijn nog geen video’s gedownload.'
                      )
                    }}
                  </li>
                }
              }
              @if (virtualBottom() > 0) {
                <li class="spacer" [style.height.px]="virtualBottom()"></li>
              }
            </ul>
            @if (loadingMore()) {
              <p class="loading-more">{{ t('Loading more videos…', 'Volgende video’s laden…') }}</p>
            }
          </div>
        } @else if (settingsLoaded() && page() === 'channels') {
          <section class="channels-page">
            <p>
              {{
                t(
                  'Add a channel to scan and sync new videos.',
                  'Voeg een kanaal toe om nieuwe video’s te scannen en te synchroniseren.'
                )
              }}
            </p>
            <p class="reorder-hint">
              <strong>{{ t('Change sync order:', 'Syncvolgorde wijzigen:') }}</strong>
              {{
                t(
                  'Drag a channel using the ⠿ handle. Channels higher in the list are synced first; active downloads are not interrupted.',
                  'Sleep een kanaal met het ⠿-handvat omhoog of omlaag. Kanalen hoger in de lijst krijgen eerst voorrang; lopende downloads worden niet onderbroken.'
                )
              }}
            </p>
            <form class="bar" (submit)="$event.preventDefault(); addChannel()">
              <input
                type="url"
                placeholder="https://www.youtube.com/@channelname"
                [value]="channelUrl()"
                (input)="channelUrl.set($any($event.target).value)"
              />
              <button type="submit" [disabled]="addingChannel() || !channelUrl().trim()">
                {{ t('Add channel', 'Kanaal toevoegen') }}
              </button>
            </form>
            @if (channelScanMessage()) {
              <p class="count">{{ channelScanMessage() }}</p>
            }
            <ul class="channel-list">
              @for (channel of channels(); track channel.url) {
                <li
                  class="channel-item"
                  draggable="true"
                  [class.dragging]="draggedChannelUrl() === channel.url"
                  (dragstart)="startChannelDrag(channel, $event)"
                  (dragover)="$event.preventDefault()"
                  (drop)="dropChannel(channel, $event)"
                  (dragend)="draggedChannelUrl.set(null)"
                >
                  <span
                    class="drag-handle"
                    [attr.title]="
                      t('Drag to change sync order', 'Sleep om de syncvolgorde te wijzigen')
                    "
                    aria-hidden="true"
                    >⠿</span
                  >
                  <button type="button" class="channel-main" (click)="openChannel(channel)">
                    <strong>{{ channel.title }}</strong><small>{{ channel.url }}</small>
                  </button>
                  <label class="autosync-toggle">
                    <input
                      type="checkbox"
                      [checked]="channel.autoSync"
                      [disabled]="syncingChannelUrl() === channel.url"
                      (change)="toggleAutoSync(channel, $any($event.target).checked)"
                    />
                    <span>{{ t('Auto-sync', 'Auto-sync') }}</span>
                  </label>
                  <button type="button" class="danger" (click)="removeChannel(channel)">
                    {{ t('Remove', 'Verwijderen') }}
                  </button>
                </li>
              } @empty {
                @if (!addingChannel()) {
                  <li class="empty">
                    {{
                      t(
                        'You have not bookmarked any channels yet.',
                        'Je hebt nog geen kanalen gebookmarkt.'
                      )
                    }}
                  </li>
                }
              }
            </ul>
          </section>
        } @else if (settingsLoaded() && page() === 'suggestions') {
          <section class="suggestions-page">
            <p>
              {{
                t(
                  'Browse verified YouTube channels from the self-reliance skills guide. Add a channel to My Channels to bookmark it; auto-sync remains off until you enable it there.',
                  'Bekijk gecontroleerde YouTube-kanalen uit de gids voor zelfredzaamheid. Voeg een kanaal toe aan Mijn kanalen om het te bewaren; auto-sync blijft uit totdat je die daar aanzet.'
                )
              }}
            </p>
            <div class="bar tools">
              <input
                type="search"
                [placeholder]="t('Search suggested channels', 'Zoek voorgestelde kanalen')"
                [value]="suggestionQuery()"
                (input)="suggestionQuery.set($any($event.target).value)"
              />
            </div>
            @if (suggestionsLoading()) {
              <p class="count">{{ t('Loading suggestions…', 'Suggesties laden…') }}</p>
            }
            @for (section of filteredSuggestionSections(); track section.title) {
              <section class="suggestion-section">
                <h2>{{ section.title }}</h2>
                @for (subsection of section.subsections; track subsection.title) {
                  <section class="suggestion-subsection">
                    <h3>{{ subsection.title }}</h3>
                    <div class="suggestion-list">
                      @for (suggestion of subsection.channels; track suggestion.url) {
                        <article class="suggestion-item">
                          <div class="suggestion-info">
                            <h4>{{ suggestion.title }}</h4>
                          </div>
                          <a
                            class="suggestion-link"
                            [href]="suggestion.url"
                            target="_blank"
                            rel="noopener noreferrer"
                            >YouTube ↗</a
                          >
                          <button
                            type="button"
                            [disabled]="
                              isSuggestionAdded(suggestion) || addingSuggestionUrl() !== null
                            "
                            (click)="addSuggestedChannel(suggestion)"
                          >
                            {{
                              isSuggestionAdded(suggestion)
                                ? t('Added to My Channels', 'Toegevoegd aan Mijn kanalen')
                                : addingSuggestionUrl() === suggestion.url
                                  ? t('Adding…', 'Toevoegen…')
                                  : t('Add to my Channels', 'Toevoegen aan Mijn kanalen')
                            }}
                          </button>
                        </article>
                      }
                    </div>
                  </section>
                }
              </section>
            } @empty {
              @if (!suggestionsLoading()) {
                <p class="empty">
                  {{ t('No matching suggestions.', 'Geen passende suggesties.') }}
                </p>
              }
            }
          </section>
        } @else if (settingsLoaded() && page() === 'sync-progress') {
          <section class="sync-progress-page" aria-live="polite">
            <div class="sync-controls">
              <p class="count">
                {{ t('Updates every 2 seconds.', 'Wordt automatisch elke 2 seconden bijgewerkt.') }}
                {{
                  state().syncEnabled
                    ? t('Sync is active.', 'Synchronisatie is actief.')
                    : t('Sync is paused.', 'Synchronisatie is gepauzeerd.')
                }}
              </p>
              <button type="button" [disabled]="syncToggleLoading()" (click)="toggleSync()">
                {{
                  syncToggleLoading()
                    ? t('Working…', 'Bezig…')
                    : state().syncEnabled
                      ? t('Stop syncing', 'Stop synchroniseren')
                      : t('Start syncing', 'Start synchroniseren')
                }}
              </button>
            </div>
            @if (isRateLimitCoolingDown()) {
              <p class="count rate-limit-notice">
                {{
                  t(
                    'YouTube rate-limited this account. Downloads remain queued and will retry in about ',
                    'YouTube heeft dit account tijdelijk beperkt. Downloads blijven in de wachtrij en worden over ongeveer '
                  )
                }}{{ retryMinutes() }} {{ t('min.', 'min. opnieuw geprobeerd.') }}
              </p>
            }
            @for (channel of syncProgress(); track channel.url) {
              <article class="channel-progress-card">
                <div class="channel-progress-heading">
                  <div>
                    <h2>{{ channel.title }}</h2>
                    <small
                      >{{ channel.completed }} / {{ channel.total }}
                      {{ t('videos complete', 'video’s gereed') }}</small
                    >
                  </div>
                  <span>{{ channel.percent }}%</span>
                </div>
                <progress
                  class="channel-progress-bar"
                  [value]="channel.percent"
                  max="100"
                ></progress>
                @if (channel.scanning) {
                  <p class="count">{{ t('Scanning channel…', 'Kanaal wordt gescand…') }}</p>
                }
                @if (channel.active.length) {
                  <h3>{{ t('In progress', 'Bezig') }}</h3>
                  @for (video of channel.active; track video.id) {
                    <article class="sync-video">
                      <img
                        [src]="video.thumbnail"
                        [alt]="t('Thumbnail: ', 'Thumbnail: ') + video.title"
                        width="120"
                        height="68"
                      />
                      <div class="sync-info">
                        <strong>{{ video.title }}</strong>
                        <div class="progress-line">
                          <progress [value]="video.progress" max="100"></progress
                          ><span>{{ video.progress }}%</span>
                        </div>
                      </div>
                    </article>
                  }
                }
                @if (channel.queued.length) {
                  <h3>{{ t('Queue', 'Wachtrij') }} · {{ channel.queued.length }}</h3>
                  @for (video of channel.queued.slice(0, 5); track video.id) {
                    <article class="sync-video queued-video">
                      <img
                        [src]="video.thumbnail"
                        [alt]="t('Thumbnail: ', 'Thumbnail: ') + video.title"
                        width="120"
                        height="68"
                      />
                      <div class="sync-info">
                        <strong>{{ video.title }}</strong><span>{{
                          t('Queued', 'In wachtrij')
                        }}</span>
                      </div>
                    </article>
                  }
                }
                @if (channel.failed.length) {
                  <p class="error">
                    {{ channel.failed.length }} {{ t('videos failed.', 'video’s zijn mislukt.') }}
                  </p>
                }
              </article>
            } @empty {
              <p class="empty">
                {{
                  t(
                    'There are no bookmarked channels yet.',
                    'Er zijn nog geen gebookmarkte kanalen.'
                  )
                }}
              </p>
            }
          </section>
        } @else if (settingsLoaded()) {
          <p class="count">
            {{ channelTotal() }} {{ t('videos in this channel', 'video’s in dit kanaal') }} ·
            {{ importVideos().length }} {{ t('loaded', 'geladen') }}
          </p>
          <div class="video-scroll import-scroll" (scroll)="onChannelScroll($event)">
            <ul class="import-list">
              @if (channelVirtualStart() > 0) {
                <li
                  class="spacer"
                  [style.height.px]="channelVirtualStart() * channelRowHeight"
                ></li>
              }
              @for (v of visibleChannelVideos(); track v.id) {
                <li class="import-video-row">
                  <label [class.done]="isDone(v.id)">
                    <input
                      type="checkbox"
                      [checked]="isDone(v.id) || isBusy(v.id) || selected().has(v.id)"
                      [disabled]="isDone(v.id) || isBusy(v.id)"
                      (change)="toggle(v.id)"
                    />
                    <img [src]="v.thumbnail" alt="" loading="lazy" width="120" height="68" />
                    <span class="title">{{ v.title }}</span><span class="dur">{{
                      fmt(v.duration)
                    }}</span>
                    <span class="badge" [class]="badgeClass(v.id)">{{ badge(v.id) }}</span>
                  </label>
                </li>
              } @empty {
                @if (loading()) {
                  <li class="empty">{{ t('Scanning channel…', 'Kanaal wordt gescand…') }}</li>
                } @else {
                  <li class="empty">
                    {{
                      t(
                        'No videos found for this channel.',
                        'Geen video’s gevonden voor dit kanaal.'
                      )
                    }}
                  </li>
                }
              }
              @if (channelVirtualBottom() > 0) {
                <li class="spacer" [style.height.px]="channelVirtualBottom()"></li>
              }
            </ul>
            @if (channelPageLoading() && importVideos().length) {
              <p class="loading-more">{{ t('Loading more videos…', 'Volgende video’s laden…') }}</p>
            }
          </div>
          @if (selected().size) {
            <button type="button" class="import-download" (click)="download()">
              {{ t('Download', 'Download') }} {{ selected().size }}
              {{ t('selected', 'geselecteerd') }}
            </button>
          }
        }
        @if (playingVideo()) {
          <div class="player-backdrop" (click)="closePlayer()" (keydown.escape)="closePlayer()">
            <section
              class="player-dialog"
              role="dialog"
              aria-modal="true"
              [attr.aria-label]="playingVideo()!.title"
              (click)="$event.stopPropagation()"
            >
              <div class="player-heading">
                <h2>{{ playingVideo()!.title }}</h2>
                <button
                  type="button"
                  class="close-player"
                  [attr.aria-label]="t('Close video player', 'Videospeler sluiten')"
                  (click)="closePlayer()"
                >
                  ×
                </button>
              </div>
              <video
                #player
                [src]="videoStreamUrl()"
                [poster]="playingVideo()!.thumbnail"
                controls
                autoplay
                playsinline
                crossorigin="anonymous"
                (loadedmetadata)="applySubtitleLanguage(player)"
              >
                <track
                  kind="subtitles"
                  [src]="subtitleUrl('en')"
                  srclang="en"
                  label="English"
                  [default]="language() === 'en'"
                  (load)="applySubtitleLanguage(player)"
                />
                <track
                  kind="subtitles"
                  [src]="subtitleUrl('nl')"
                  srclang="nl"
                  label="Nederlands"
                  [default]="language() === 'nl'"
                  (load)="applySubtitleLanguage(player)"
                />
              </video>
            </section>
          </div>
        }
        @if (failureLogOpen()) {
          <div
            class="failure-backdrop"
            (click)="closeFailureLog()"
            (keydown.escape)="closeFailureLog()"
          >
            <section
              class="failure-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="failure-log-title"
              (click)="$event.stopPropagation()"
            >
              <div class="failure-heading">
                <div>
                  <h2 id="failure-log-title">
                    {{ t('Latest 1,000 failure log lines', 'Laatste 1.000 regels faallog') }}
                  </h2>
                  <span>{{ failureLog().length }} {{ t('lines loaded', 'regels geladen') }}</span>
                </div>
                <button
                  type="button"
                  class="close-player"
                  [attr.aria-label]="t('Close failure log', 'Faallog sluiten')"
                  (click)="closeFailureLog()"
                >
                  ×
                </button>
              </div>
              <div class="failure-log-content" tabindex="0">
                <pre>{{
                  failureLog().join(
                    '
'
                  ) ||
                    t(
                      'There are no failures in the log yet.',
                      'Er zijn nog geen fouten in de faallog.'
                    )
                }}</pre>
              </div>
            </section>
          </div>
        }
        @if (error()) {
          <p class="error" role="alert">{{ error() }}</p>
        }
      </main>
    </div>
  `,
  styles: [
    `
      :host {
        --bg: #eef1f4;
        --surface: #fff;
        --ink: #16202a;
        --muted: #5d6b78;
        --line: #d5dce2;
        --accent: #0f6b5c;
        --accent-ink: #fff;
        --warn: #b3261e;
        display: block;
        min-height: 100vh;
        background: var(--bg);
        color: var(--ink);
        font:
          15px/1.45 system-ui,
          -apple-system,
          'Segoe UI',
          sans-serif;
      }
      @media (prefers-color-scheme: dark) {
        :host {
          --bg: #11171c;
          --surface: #1a232b;
          --ink: #e6ecf1;
          --muted: #94a3b0;
          --line: #2b3844;
          --accent: #3fb8a1;
          --accent-ink: #08201b;
          --warn: #ff8a80;
        }
      }
      .layout {
        display: grid;
        grid-template-columns: 230px minmax(0, 1fr);
        min-height: 100vh;
      }
      .sidebar {
        background: var(--surface);
        border-right: 1px solid var(--line);
        padding: 24px 14px;
      }
      .brand {
        font-weight: 700;
        font-size: 17px;
        padding: 0 10px 28px;
      }
      .nav-item {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        margin: 4px 0;
        padding: 11px 12px;
        background: transparent;
        border-color: transparent;
        color: var(--ink);
        text-align: left;
      }
      .nav-item.active {
        background: color-mix(in srgb, var(--accent) 12%, transparent);
        color: var(--accent);
      }
      main {
        min-width: 0;
        padding: 24px 28px 64px;
      }
      h1 {
        margin: 0;
        font-size: 26px;
        letter-spacing: -0.01em;
      }
      header {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      }
      header h1 {
        margin-right: auto;
      }
      .title-tools {
        display: flex;
        align-items: center;
        gap: 14px;
        margin-right: auto;
      }
      .title-tools h1 {
        margin: 0;
      }
      .log-link {
        padding: 5px 2px;
        border: 0;
        background: transparent;
        color: var(--accent);
        text-decoration: underline;
      }
      .settings {
        padding: 6px 11px;
        font-size: 20px;
        line-height: 1;
      }
      .dir {
        margin: 4px 0 20px;
        color: var(--muted);
        font-size: 13px;
        word-break: break-all;
      }
      .setup {
        padding: 20px 0;
      }
      .setup h2 {
        margin: 0;
      }
      .setup p {
        color: var(--muted);
      }
      .setting-field {
        display: flex;
        align-items: center;
        gap: 16px;
        max-width: 520px;
        margin-top: 16px;
        cursor: default;
      }
      .setting-field input {
        width: 88px;
        padding: 8px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--surface);
        color: inherit;
        font: inherit;
      }
      .setting-field select {
        padding: 8px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--surface);
        color: inherit;
        font: inherit;
      }
      .setting-hint {
        margin-top: 6px;
        font-size: 13px;
      }
      .sync-controls {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 14px;
      }
      .bar {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 12px;
      }
      .bar input {
        flex: 1 1 280px;
      }
      .tools input {
        flex: 1 1 260px;
      }
      input[type='url'],
      input[type='search'] {
        padding: 10px 12px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--surface);
        color: inherit;
        font: inherit;
      }
      button {
        padding: 10px 16px;
        border: 1px solid var(--accent);
        border-radius: 6px;
        background: var(--accent);
        color: var(--accent-ink);
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
      button.ghost {
        background: transparent;
        color: var(--accent);
      }
      button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      :is(button, input):focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .count {
        margin: 0 0 8px;
        color: var(--muted);
        font-size: 13px;
      }
      .error {
        color: var(--warn);
      }
      .empty {
        color: var(--muted);
        padding: 24px 0;
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        overflow: hidden;
      }
      .video-scroll {
        position: relative;
        height: calc(100vh - 210px);
        min-height: 300px;
        overflow: auto;
        border-radius: 8px;
      }
      .video-scroll ul {
        min-height: 100%;
      }
      li + li {
        border-top: 1px solid var(--line);
      }
      .video-row {
        height: ${150}px;
        box-sizing: border-box;
        overflow: hidden;
        padding: 10px;
      }
      .video-card {
        display: flex;
        align-items: center;
        gap: 18px;
        height: 100%;
        overflow: hidden;
      }
      .video-card {
        cursor: pointer;
        border-radius: 7px;
        padding: 0 10px;
        transition: background-color 120ms ease;
      }
      .video-row:hover .video-card {
        background: color-mix(in srgb, var(--ink) 7%, var(--surface));
      }
      .video-card:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
      }
      .video-card img {
        width: 180px;
        height: 102px;
        flex: 0 0 auto;
      }
      .video-info {
        min-width: 0;
      }
      .video-info h2 {
        margin: 0;
        font-size: 17px;
        line-height: 1.35;
      }
      .video-info .dur {
        margin: 6px 0;
      }
      .keywords {
        margin: 6px 0 0;
        color: var(--muted);
        font-size: 13px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .spacer {
        border: 0 !important;
        pointer-events: none;
      }
      .loading-more {
        position: sticky;
        bottom: 0;
        text-align: center;
        padding: 8px;
        color: var(--muted);
        background: var(--surface);
      }
      .import-list {
        margin-top: 14px;
      }
      .import-list {
        margin-top: 0;
      }
      .import-video-row {
        height: 86px;
        box-sizing: border-box;
        overflow: hidden;
      }
      .import-download {
        margin-top: 12px;
      }
      .channels-page > p {
        color: var(--muted);
      }
      .channels-page > .reorder-hint {
        margin: 10px 0 18px;
        padding: 10px 12px;
        border-left: 3px solid var(--accent);
        background: color-mix(in srgb, var(--accent) 7%, var(--surface));
        color: var(--ink);
      }
      .sync-status {
        margin: 20px 0 24px;
        padding: 16px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
      }
      .sync-heading {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
      }
      .sync-heading h2 {
        margin: 0;
        font-size: 17px;
      }
      .sync-heading span,
      .sync-info > span,
      .queue-label {
        color: var(--muted);
        font-size: 13px;
      }
      .sync-video {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 9px 0;
      }
      .sync-video + .sync-video {
        border-top: 1px solid var(--line);
      }
      .sync-video img {
        flex: 0 0 auto;
        width: 120px;
        height: 68px;
        border-radius: 5px;
        object-fit: cover;
      }
      .sync-info {
        flex: 1;
        min-width: 0;
      }
      .sync-info strong {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .progress-line {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 5px;
      }
      .progress-line progress {
        flex: 1;
        height: 9px;
        accent-color: var(--accent);
      }
      .progress-line span {
        width: 42px;
        text-align: right;
        font-size: 13px;
        font-variant-numeric: tabular-nums;
      }
      .queue-label {
        margin: 14px 0 2px;
        font-weight: 600;
      }
      .sync-empty {
        margin: 0;
        padding: 10px 0 0;
      }
      .channel-list {
        margin-top: 20px;
      }
      .channel-progress-card {
        margin: 16px 0;
        padding: 16px;
        border: 1px solid var(--line);
        border-radius: 9px;
        background: var(--surface);
      }
      .channel-progress-heading {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      .channel-progress-heading h2 {
        margin: 0;
        font-size: 18px;
      }
      .channel-progress-heading small {
        color: var(--muted);
      }
      .channel-progress-heading > span {
        font-size: 20px;
        font-weight: 700;
        color: var(--accent);
      }
      .channel-progress-bar {
        width: 100%;
        height: 10px;
        margin: 10px 0;
        accent-color: var(--accent);
      }
      .channel-progress-card h3 {
        margin: 14px 0 0;
        font-size: 14px;
      }
      .channel-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px;
      }
      .channel-item[draggable='true'] {
        cursor: grab;
      }
      .channel-item.dragging {
        opacity: 0.45;
      }
      .drag-handle {
        flex: 0 0 auto;
        color: var(--muted);
        font-size: 22px;
        cursor: grab;
        user-select: none;
      }
      .channel-item > div {
        flex: 1;
        min-width: 0;
      }
      .channel-main {
        flex: 1;
        min-width: 0;
        display: block;
        padding: 4px;
        border: 0;
        background: transparent;
        color: inherit;
        text-align: left;
      }
      .channel-main:hover {
        background: color-mix(in srgb, var(--ink) 6%, var(--surface));
      }
      .channel-item strong,
      .channel-item small {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .channel-item small {
        color: var(--muted);
      }
      .autosync-toggle {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        white-space: nowrap;
        cursor: pointer;
      }
      .autosync-toggle input {
        appearance: none;
        position: relative;
        width: 40px;
        height: 23px;
        margin: 0;
        border: 0;
        border-radius: 999px;
        background: var(--line);
        cursor: pointer;
        transition: background-color 120ms ease;
      }
      .autosync-toggle input::before {
        content: '';
        position: absolute;
        top: 3px;
        left: 3px;
        width: 17px;
        height: 17px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 1px 2px rgb(0 0 0 / 25%);
        transition: transform 120ms ease;
      }
      .autosync-toggle input:checked {
        background: var(--accent);
      }
      .autosync-toggle input:checked::before {
        transform: translateX(17px);
      }
      button.danger {
        background: transparent;
        color: var(--warn);
        border-color: var(--warn);
      }
      .player-backdrop {
        position: fixed;
        inset: 0;
        z-index: 10;
        display: grid;
        place-items: center;
        padding: 24px;
        background: rgb(0 0 0 / 72%);
      }
      .player-dialog {
        width: min(100%, 1000px);
        overflow: hidden;
        border-radius: 10px;
        background: var(--surface);
        box-shadow: 0 20px 60px rgb(0 0 0 / 35%);
      }
      .player-heading {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 12px 16px;
      }
      .player-heading h2 {
        flex: 1;
        min-width: 0;
        margin: 0;
        font-size: 17px;
      }
      .close-player {
        padding: 2px 12px;
        font-size: 25px;
        line-height: 1.2;
      }
      .player-dialog video {
        display: block;
        width: 100%;
        max-height: calc(100vh - 120px);
        background: #000;
      }
      .failure-backdrop {
        position: fixed;
        inset: 0;
        z-index: 20;
        display: grid;
        place-items: center;
        padding: 24px;
        background: rgb(0 0 0 / 65%);
      }
      .failure-dialog {
        width: min(100%, 900px);
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 0;
        background: var(--surface);
        color: var(--ink);
        box-shadow: 0 20px 60px rgb(0 0 0 / 35%);
      }
      .failure-heading {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
        padding: 14px 18px;
        border-bottom: 1px solid var(--line);
      }
      .failure-heading h2 {
        margin: 0;
        font-size: 18px;
      }
      .failure-heading span {
        color: var(--muted);
        font-size: 13px;
      }
      .failure-log-content {
        max-height: min(70vh, 720px);
        overflow: auto;
        padding: 16px 18px;
      }
      .failure-log-content pre {
        margin: 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font:
          12px/1.5 ui-monospace,
          SFMono-Regular,
          Menlo,
          monospace;
      }
      label {
        display: grid;
        grid-template-columns: auto 120px 1fr auto auto;
        gap: 12px;
        align-items: center;
        padding: 8px 12px;
        cursor: pointer;
      }
      label.done {
        cursor: default;
      }
      label.done .title,
      label.done img {
        opacity: 0.55;
      }
      input[type='checkbox'] {
        width: 18px;
        height: 18px;
        accent-color: var(--accent);
      }
      input[type='checkbox']:disabled {
        cursor: not-allowed;
      }
      img {
        border-radius: 4px;
        background: var(--line);
        object-fit: cover;
      }
      .dur {
        color: var(--muted);
        font-variant-numeric: tabular-nums;
        font-size: 13px;
      }
      .badge {
        min-width: 88px;
        text-align: right;
        font-size: 13px;
        color: var(--muted);
      }
      .badge.done {
        color: var(--accent);
        font-weight: 600;
      }
      .badge.failed {
        color: var(--warn);
        font-weight: 600;
      }
      .badge.active {
        color: var(--ink);
        font-weight: 600;
      }
      @media (max-width: 600px) {
        .layout {
          grid-template-columns: 66px minmax(0, 1fr);
        }
        .sidebar {
          padding: 18px 6px;
        }
        .brand {
          font-size: 0;
          padding: 0 0 22px;
        }
        .brand::first-letter {
          font-size: 17px;
        }
        .nav-item {
          justify-content: center;
          padding: 11px 4px;
        }
        .nav-item span {
          display: none;
        }
        main {
          padding: 18px 12px 48px;
        }
        label {
          grid-template-columns: auto 1fr;
        }
        img,
        .dur {
          display: none;
        }
        .video-card img {
          display: block;
          width: 112px;
          height: 63px;
        }
        .video-card .dur {
          display: block;
        }
        .video-card {
          gap: 10px;
        }
        .badge {
          grid-column: 2;
          text-align: left;
        }
        .suggestion-item {
          grid-template-columns: minmax(0, 1fr);
        }
        .suggestion-link,
        .suggestion-item button {
          grid-column: auto;
          grid-row: auto;
        }
      }

      :host {
        --bg: #070b17;
        --surface: #10182b;
        --ink: #edf5ff;
        --muted: #8f9eb8;
        --line: rgba(129, 164, 220, 0.17);
        --accent: #48d9ff;
        --accent-ink: #06101d;
        --warn: #ff668a;
        min-height: 100vh;
        color-scheme: dark;
        background:
          radial-gradient(ellipse at 83% -15%, rgba(86, 43, 159, 0.28), transparent 44%),
          radial-gradient(ellipse at 0% 80%, rgba(10, 102, 145, 0.13), transparent 40%), var(--bg);
        color: var(--ink);
        font-family: Inter, 'SF Pro Display', 'Segoe UI', sans-serif;
        letter-spacing: 0.01em;
      }
      :host::before {
        content: '';
        position: fixed;
        inset: 0;
        z-index: -1;
        pointer-events: none;
        opacity: 0.19;
        background-image:
          linear-gradient(rgba(122, 160, 220, 0.07) 1px, transparent 1px),
          linear-gradient(90deg, rgba(122, 160, 220, 0.07) 1px, transparent 1px);
        background-size: 46px 46px;
        mask-image: linear-gradient(to bottom, black, transparent 82%);
      }
      .layout {
        grid-template-columns: 254px minmax(0, 1fr);
        gap: 0;
      }
      .sidebar {
        position: sticky;
        top: 0;
        height: 100vh;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        padding: 30px 17px 22px;
        background: rgba(8, 13, 28, 0.88);
        border-right: 1px solid var(--line);
        backdrop-filter: blur(24px);
      }
      .brand {
        position: relative;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 0 10px 40px 46px;
        font-size: 14px;
        font-weight: 750;
        letter-spacing: 0.13em;
        text-transform: uppercase;
      }
      .brand::before {
        content: '▶';
        position: absolute;
        left: 8px;
        top: -2px;
        display: grid;
        place-items: center;
        width: 27px;
        height: 27px;
        border: 1px solid rgba(72, 217, 255, 0.55);
        border-radius: 9px;
        color: var(--accent);
        font-size: 10px;
        background: linear-gradient(145deg, rgba(72, 217, 255, 0.16), rgba(164, 71, 255, 0.18));
        box-shadow: 0 0 24px rgba(72, 217, 255, 0.12);
      }
      .sidebar::after {
        content: '●  LOCAL ARCHIVE  /  READY';
        margin: auto 6px 0;
        padding: 15px 9px 0;
        border-top: 1px solid var(--line);
        color: #71819f;
        font:
          9px/1.4 ui-monospace,
          SFMono-Regular,
          Menlo,
          monospace;
        letter-spacing: 0.09em;
      }
      .nav-item {
        position: relative;
        gap: 13px;
        margin: 4px 0;
        padding: 12px 13px;
        border: 1px solid transparent;
        border-radius: 9px;
        color: #97a7c2;
        font-size: 13px;
        letter-spacing: 0.025em;
        transition: 0.18s ease;
      }
      .nav-item:hover {
        color: var(--ink);
        border-color: rgba(72, 217, 255, 0.13);
        background: rgba(72, 217, 255, 0.045);
      }
      .nav-item.active {
        color: #e8f9ff;
        border-color: rgba(72, 217, 255, 0.25);
        background: linear-gradient(100deg, rgba(33, 171, 223, 0.16), rgba(119, 72, 201, 0.09));
        box-shadow:
          inset 2px 0 var(--accent),
          0 5px 22px rgba(10, 26, 48, 0.28);
      }
      .nav-item.active::after {
        content: '';
        width: 5px;
        height: 5px;
        margin-left: auto;
        border-radius: 50%;
        background: var(--accent);
        box-shadow: 0 0 10px var(--accent);
      }
      main {
        min-width: 0;
        max-width: 1600px;
        width: 100%;
        box-sizing: border-box;
        margin: 0 auto;
        padding: 36px clamp(20px, 4vw, 64px) 72px;
      }
      header {
        position: relative;
        min-height: 52px;
        margin-bottom: 27px;
        align-items: center;
      }
      header h1,
      .title-tools h1 {
        color: #f4f8ff;
        font-size: clamp(23px, 2.4vw, 31px);
        font-weight: 650;
        letter-spacing: -0.045em;
      }
      header h1::before,
      .title-tools h1::before {
        content: 'COLLECTION / ';
        display: block;
        margin-bottom: 6px;
        color: #7587a6;
        font:
          9px/1.2 ui-monospace,
          SFMono-Regular,
          Menlo,
          monospace;
        letter-spacing: 0.19em;
      }
      .dir {
        max-width: min(37vw, 460px);
        margin: 13px 12px 0 auto;
        color: #74849f;
        font:
          10px/1.4 ui-monospace,
          SFMono-Regular,
          Menlo,
          monospace;
      }
      button {
        border: 1px solid rgba(72, 217, 255, 0.65);
        border-radius: 7px;
        background: linear-gradient(110deg, #42d7f7, #6d91ff 65%, #a66bf4);
        color: #06101d;
        font-size: 12px;
        font-weight: 750;
        letter-spacing: 0.035em;
        box-shadow: 0 5px 20px rgba(62, 157, 247, 0.14);
        transition:
          transform 0.16s ease,
          box-shadow 0.16s ease,
          filter 0.16s ease;
      }
      button:hover:not(:disabled) {
        transform: translateY(-1px);
        filter: brightness(1.08);
        box-shadow: 0 8px 26px rgba(62, 157, 247, 0.24);
      }
      button.ghost,
      .log-link {
        background: rgba(20, 34, 59, 0.6);
        color: #a8c3e5;
        border-color: var(--line);
        box-shadow: none;
      }
      button.danger {
        background: rgba(255, 70, 117, 0.07);
        color: #ff7d9b;
        border-color: rgba(255, 102, 138, 0.28);
        box-shadow: none;
      }
      .settings {
        width: 42px;
        height: 42px;
        padding: 0;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: rgba(21, 31, 53, 0.85);
        color: #b9c8e1;
        font-size: 19px;
        box-shadow: none;
      }
      .settings:hover:not(:disabled) {
        color: var(--accent);
        border-color: rgba(72, 217, 255, 0.45);
      }
      input[type='url'],
      input[type='search'],
      input[type='text'],
      input[type='number'],
      select {
        border: 1px solid rgba(139, 164, 209, 0.24);
        border-radius: 8px;
        background: rgba(10, 17, 33, 0.82);
        color: #eaf3ff;
        font: inherit;
        outline: none;
        transition:
          border-color 0.18s,
          box-shadow 0.18s;
      }
      input[type='url'],
      input[type='search'],
      input[type='text'] {
        padding: 13px 15px;
      }
      input::placeholder {
        color: #71809a;
      }
      :is(input, select):focus {
        border-color: rgba(72, 217, 255, 0.7);
        box-shadow:
          0 0 0 3px rgba(72, 217, 255, 0.08),
          0 0 22px rgba(72, 217, 255, 0.07);
      }
      .setting-field input,
      .setting-field select {
        border: 1px solid rgba(139, 164, 209, 0.24);
        border-radius: 8px;
        background: #0a1121;
        color: var(--ink);
      }
      .setup {
        margin: 20px 0;
        padding: 24px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: linear-gradient(135deg, rgba(20, 32, 56, 0.9), rgba(13, 20, 38, 0.94));
        box-shadow: 0 22px 60px rgba(0, 0, 0, 0.16);
      }
      .setup h2 {
        font-size: 21px;
        letter-spacing: -0.025em;
      }
      .setup p,
      .channels-page > p {
        color: #8d9db7;
      }
      .setting-field {
        color: #bdcbe0;
        font-size: 13px;
      }
      .setting-hint {
        color: #7889a5 !important;
      }
      .hero-banner {
        position: relative;
        min-height: 235px;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 28px;
        margin: 0 0 24px;
        padding: 30px clamp(24px, 4vw, 52px);
        border: 1px solid rgba(112, 144, 226, 0.3);
        border-radius: 15px;
        background:
          radial-gradient(ellipse at 73% 62%, rgba(78, 80, 214, 0.38), transparent 42%),
          linear-gradient(115deg, #112b54 0%, #172957 44%, #452457 78%, #712a57 115%);
        box-shadow:
          0 20px 65px rgba(0, 0, 0, 0.22),
          inset 0 1px rgba(255, 255, 255, 0.06);
      }
      .hero-banner::before {
        content: '';
        position: absolute;
        inset: 0;
        opacity: 0.32;
        pointer-events: none;
        background:
          linear-gradient(rgba(173, 207, 255, 0.09) 1px, transparent 1px),
          linear-gradient(90deg, rgba(173, 207, 255, 0.09) 1px, transparent 1px);
        background-size: 28px 28px;
        mask-image: linear-gradient(90deg, transparent 4%, black 82%);
      }
      .hero-banner::after {
        content: '';
        position: absolute;
        right: 19%;
        top: -52%;
        width: 270px;
        aspect-ratio: 1;
        border: 1px solid rgba(152, 191, 255, 0.12);
        border-radius: 50%;
        box-shadow:
          0 0 0 28px rgba(160, 194, 255, 0.035),
          0 0 0 57px rgba(160, 194, 255, 0.025);
      }
      .hero-copy,
      .hero-index {
        position: relative;
        z-index: 1;
      }
      .eyebrow,
      .hero-index span,
      .hero-index small {
        color: #9fbde4;
        font:
          9px/1.5 ui-monospace,
          SFMono-Regular,
          Menlo,
          monospace;
        letter-spacing: 0.22em;
      }
      .hero-copy h2 {
        margin: 12px 0 8px;
        color: #f8fbff;
        font-size: clamp(29px, 4vw, 46px);
        line-height: 1.03;
        font-weight: 620;
        letter-spacing: -0.055em;
      }
      .hero-copy h2 span {
        color: #68e0fb;
        text-shadow: 0 0 24px rgba(72, 217, 255, 0.2);
      }
      .hero-copy p {
        margin: 0;
        color: #b5c5df;
        font-size: 12px;
      }
      .hero-orbit {
        position: absolute;
        top: 50%;
        left: 69%;
        width: 190px;
        aspect-ratio: 1;
        transform: translate(-50%, -50%);
        border: 1px solid rgba(132, 197, 255, 0.36);
        border-radius: 50%;
        box-shadow:
          0 0 70px rgba(66, 176, 255, 0.1),
          inset 0 0 45px rgba(66, 176, 255, 0.07);
      }
      .hero-orbit::before,
      .hero-orbit::after {
        content: '';
        position: absolute;
        inset: 17px;
        border: 1px dashed rgba(149, 186, 250, 0.28);
        border-radius: 50%;
      }
      .hero-orbit::after {
        inset: 39px;
        border-style: solid;
        border-color: rgba(242, 126, 237, 0.35);
      }
      .hero-orbit i,
      .hero-orbit b,
      .hero-orbit em,
      .hero-orbit span {
        position: absolute;
        z-index: 2;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #66e4ff;
        box-shadow: 0 0 13px #66e4ff;
      }
      .hero-orbit i {
        left: 25px;
        top: 40px;
      }
      .hero-orbit b {
        right: 22px;
        top: 75px;
        background: #e787ff;
        box-shadow: 0 0 13px #e787ff;
      }
      .hero-orbit em {
        bottom: 19px;
        left: 76px;
        background: #fff;
      }
      .hero-orbit span {
        top: 23px;
        right: 64px;
        width: 4px;
        height: 4px;
      }
      .orbit-core {
        position: absolute;
        inset: 64px;
        display: grid;
        place-items: center;
        border: 1px solid rgba(98, 220, 255, 0.36);
        border-radius: 50%;
        background: radial-gradient(circle, rgba(73, 180, 244, 0.28), rgba(12, 24, 58, 0.75));
        color: #d7faff;
        font-size: 20px;
        text-shadow: 0 0 18px #48d9ff;
      }
      .hero-index {
        display: grid;
        min-width: 87px;
        justify-items: end;
        padding-left: 15px;
        border-left: 1px solid rgba(201, 219, 255, 0.28);
      }
      .hero-index strong {
        margin: 3px 0 -4px;
        color: #fff;
        font-size: 32px;
        font-weight: 600;
        letter-spacing: -0.05em;
      }
      .tools {
        gap: 10px;
        margin-bottom: 12px;
      }
      .tools input {
        min-height: 22px;
      }
      .count {
        color: #8595b0;
        font:
          10px/1.5 ui-monospace,
          SFMono-Regular,
          Menlo,
          monospace;
        letter-spacing: 0.04em;
      }
      ul {
        border: 1px solid var(--line);
        border-radius: 12px;
        background: rgba(12, 19, 36, 0.7);
        box-shadow: 0 14px 45px rgba(0, 0, 0, 0.12);
      }
      .video-scroll {
        height: calc(100vh - 420px);
        min-height: 280px;
      }
      .video-row {
        border-color: rgba(129, 164, 220, 0.11);
      }
      .video-card {
        border: 1px solid transparent;
      }
      .video-card img {
        border: 1px solid rgba(161, 192, 245, 0.16);
        border-radius: 8px;
        box-shadow: 0 8px 25px rgba(0, 0, 0, 0.25);
      }
      .video-info h2 {
        font-size: 15px;
        font-weight: 570;
        letter-spacing: -0.012em;
      }
      .video-row:hover .video-card {
        border-color: rgba(72, 217, 255, 0.19);
        background: linear-gradient(90deg, rgba(72, 217, 255, 0.075), rgba(136, 78, 202, 0.045));
      }
      .keywords {
        color: #7688a5;
        font-size: 11px;
      }
      .channels-page > p {
        font-size: 13px;
      }
      .channels-page > .reorder-hint {
        border: 1px solid rgba(72, 217, 255, 0.15);
        border-left: 2px solid var(--accent);
        border-radius: 0 9px 9px 0;
        background: rgba(29, 82, 111, 0.13);
        color: #b5c8e2;
      }
      .channel-list {
        margin-top: 20px;
      }
      .channel-item {
        min-height: 67px;
        border-color: rgba(129, 164, 220, 0.11);
      }
      .drag-handle {
        color: #6f82a2;
      }
      .channel-main {
        border-radius: 7px;
      }
      .channel-main:hover {
        background: rgba(72, 217, 255, 0.055);
      }
      .channel-item strong {
        font-size: 13px;
        font-weight: 600;
      }
      .channel-item small {
        color: #71819d;
        font:
          10px/1.5 ui-monospace,
          SFMono-Regular,
          Menlo,
          monospace;
      }
      .suggestions-page > p {
        color: #8d9db7;
        font-size: 13px;
      }
      .suggestion-section {
        margin-top: 26px;
        padding: 16px;
        border: 1px solid rgba(72, 217, 255, 0.2);
        border-radius: 14px;
        background: linear-gradient(145deg, rgba(18, 44, 70, 0.48), rgba(13, 20, 38, 0.64));
        box-shadow: 0 12px 34px rgba(0, 0, 0, 0.12);
      }
      .suggestion-section > h2 {
        margin: 0 0 18px;
        padding: 12px 15px;
        border-left: 4px solid #48d9ff;
        border-radius: 7px;
        background: linear-gradient(90deg, rgba(44, 151, 190, 0.2), rgba(24, 83, 126, 0.07));
        color: #7ce7ff;
        font-size: 21px;
        letter-spacing: 0.01em;
      }
      .suggestion-subsection {
        margin: 18px 0 0 10px;
        padding-left: 14px;
        border-left: 2px solid rgba(182, 124, 255, 0.5);
      }
      .suggestion-subsection > h3 {
        margin: 0 0 10px;
        padding: 9px 13px;
        border: 1px solid rgba(182, 124, 255, 0.2);
        border-radius: 8px;
        background: linear-gradient(90deg, rgba(106, 62, 155, 0.24), rgba(58, 39, 93, 0.12));
        color: #d8bcff;
        font-size: 14px;
        font-weight: 600;
      }
      .suggestion-list {
        display: grid;
        gap: 8px;
      }
      .suggestion-item {
        display: grid;
        grid-template-columns: minmax(180px, 1fr) minmax(90px, 150px) auto;
        gap: 14px;
        align-items: center;
        padding: 13px 15px;
        border: 1px solid rgba(129, 164, 220, 0.12);
        border-radius: 10px;
        background: rgba(16, 24, 43, 0.78);
      }
      .suggestion-info {
        min-width: 0;
      }
      .suggestion-info h4 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
      }
      .suggestion-link {
        color: #73dfff;
        font-size: 12px;
        text-decoration: none;
      }
      .suggestion-link:hover {
        text-decoration: underline;
      }
      .channel-progress-card {
        padding: 20px;
        border: 1px solid var(--line);
        border-radius: 13px;
        background: linear-gradient(135deg, rgba(17, 26, 47, 0.94), rgba(13, 19, 36, 0.88));
        box-shadow: 0 15px 40px rgba(0, 0, 0, 0.15);
      }
      .channel-progress-heading h2 {
        font-size: 16px;
        font-weight: 600;
      }
      .channel-progress-heading > span {
        color: #61ddfa;
        text-shadow: 0 0 15px rgba(72, 217, 255, 0.3);
      }
      progress {
        accent-color: var(--accent);
      }
      .channel-progress-bar {
        border-radius: 10px;
        accent-color: #5ddfff;
      }
      .channel-progress-card h3 {
        color: #aebdd5;
        font-size: 10px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .sync-video {
        border-color: var(--line);
      }
      .sync-video img {
        border: 1px solid var(--line);
      }
      .failure-backdrop,
      .player-backdrop {
        backdrop-filter: blur(12px);
      }
      .failure-dialog,
      .player-dialog {
        border: 1px solid rgba(130, 171, 235, 0.23);
        border-radius: 14px;
        background: #0e172b;
        color: var(--ink);
        box-shadow: 0 28px 100px rgba(0, 0, 0, 0.56);
      }
      .failure-heading {
        border-color: var(--line);
      }
      .failure-heading span {
        color: var(--muted);
      }
      .failure-log-content pre {
        color: #b5cae8;
      }
      .badge.done {
        color: #5de0c0;
      }
      .badge.failed {
        color: #ff7396;
      }
      .badge.active {
        color: #61ddfa;
      }
      .empty {
        padding: 30px 18px;
        color: #8798b5;
        text-align: center;
      }
      .error {
        padding: 12px 15px;
        border: 1px solid rgba(255, 102, 138, 0.25);
        border-radius: 9px;
        background: rgba(255, 75, 117, 0.07);
        color: #ff8da8;
      }
      .loading-more {
        color: #a6b9d5;
        background: #10182b;
      }
      ::-webkit-scrollbar {
        width: 9px;
        height: 9px;
      }
      ::-webkit-scrollbar-track {
        background: rgba(4, 9, 19, 0.4);
      }
      ::-webkit-scrollbar-thumb {
        border: 2px solid #0a1020;
        border-radius: 8px;
        background: #334565;
      }
      ::-webkit-scrollbar-thumb:hover {
        background: #4e709a;
      }
      @media (max-width: 800px) {
        .layout {
          grid-template-columns: 205px minmax(0, 1fr);
        }
        main {
          padding-inline: 22px;
        }
        .hero-orbit {
          left: 69%;
          transform: translate(-50%, -50%) scale(0.8);
        }
      }
      @media (max-width: 600px) {
        .layout {
          grid-template-columns: 62px minmax(0, 1fr);
        }
        .sidebar {
          padding: 20px 5px;
        }
        .brand {
          padding: 0 0 35px;
        }
        .brand::before {
          left: 12px;
        }
        .sidebar::after {
          writing-mode: vertical-rl;
          align-self: center;
          padding: 12px 0 0;
          font-size: 7px;
        }
        .nav-item {
          min-height: 41px;
        }
        .nav-item.active::after {
          display: none;
        }
        main {
          padding: 20px 13px 48px;
        }
        header {
          gap: 8px;
          margin-bottom: 18px;
        }
        header h1,
        .title-tools h1 {
          font-size: 22px;
        }
        .dir {
          order: 3;
          flex: 1 0 100%;
          max-width: 100%;
          margin: -5px 0 0;
        }
        .hero-banner {
          min-height: 207px;
          padding: 22px 18px;
        }
        .hero-copy h2 {
          font-size: 30px;
        }
        .hero-copy p {
          max-width: 200px;
          font-size: 10px;
        }
        .hero-orbit {
          left: 77%;
          transform: translate(-50%, -50%) scale(0.58);
        }
        .hero-index {
          display: none;
        }
        .video-scroll {
          height: calc(100vh - 390px);
          min-height: 260px;
        }
        .video-row {
          padding: 7px;
        }
        .video-card {
          padding: 0 5px;
        }
        .video-card img {
          width: 96px;
          height: 58px;
        }
        .video-info h2 {
          font-size: 12px;
        }
        .video-info .dur {
          font-size: 10px;
        }
        .keywords {
          display: none;
        }
        .channel-item {
          flex-wrap: wrap;
          gap: 6px;
          padding: 10px 8px;
        }
        .channel-main {
          flex-basis: calc(100% - 44px);
        }
        .autosync-toggle {
          margin-left: 30px;
          font-size: 11px;
        }
        .channel-item .danger {
          margin-left: auto;
          padding: 7px 9px;
          font-size: 10px;
        }
        .setup {
          padding: 18px;
        }
        .setting-field {
          align-items: flex-start;
          flex-direction: column;
          gap: 6px;
        }
        .setting-field select {
          max-width: 100%;
        }
        .sync-controls {
          align-items: flex-start;
          flex-direction: column;
        }
        .suggestion-section > h2 {
          font-size: 18px;
        }
        .suggestion-section {
          padding: 12px 9px;
        }
        .suggestion-subsection {
          margin-left: 4px;
          padding-left: 9px;
        }
        .suggestion-item {
          grid-template-columns: minmax(0, 1fr);
        }
        .suggestion-link,
        .suggestion-item button {
          grid-column: auto;
          grid-row: auto;
        }
      }
    `,
  ],
})
export class AppComponent {
  private http = inject(HttpClient);

  channelUrl = signal('');
  query = signal('');
  page = signal<'overview' | 'channels' | 'suggestions' | 'sync-progress' | 'import'>('overview');
  videos = signal<Video[]>([]);
  playingVideo = signal<Video | null>(null);
  channels = signal<Channel[]>([]);
  suggestions = signal<SuggestionSection[]>([]);
  suggestionQuery = signal('');
  suggestionsLoading = signal(false);
  addingSuggestionUrl = signal<string | null>(null);
  syncProgress = signal<ChannelSyncProgress[]>([]);
  failureLogOpen = signal(false);
  failureLog = signal<string[]>([]);
  selectedChannel = signal<Channel | null>(null);
  addingChannel = signal(false);
  channelScanMessage = signal('');
  syncingChannelUrl = signal('');
  draggedChannelUrl = signal<string | null>(null);
  channelReordering = signal(false);
  maxParallelDownloads = signal(1);
  cookiesBrowser = signal('chrome');
  language = signal<'en' | 'nl'>('en');
  storageLocationFixed = signal(false);
  syncToggleLoading = signal(false);
  importVideos = signal<Video[]>([]);
  channelTotal = signal(0);
  channelHasMore = signal(false);
  channelPageLoading = signal(false);
  channelVirtualStart = signal(0);
  readonly channelRowHeight = 86;
  totalVideos = signal(0);
  hasMore = signal(false);
  loadingMore = signal(false);
  virtualStart = signal(0);
  scrollTop = signal(0);
  readonly rowHeight = 150;
  readonly pageSize = 20;
  videoStreamUrl = computed(() => {
    const video = this.playingVideo();
    return video ? `${API}/videos/${video.id}/play` : '';
  });
  subtitleUrl(language: 'en' | 'nl') {
    const video = this.playingVideo();
    return video ? `${API}/videos/${video.id}/subtitles/${language}` : '';
  }
  selected = signal<ReadonlySet<string>>(new Set());
  state = signal<State>({
    dir: '',
    downloaded: [],
    queued: [],
    current: null,
    syncEnabled: true,
    failed: [],
  });
  settingsOpen = signal(false);
  settingsLoaded = signal(false);
  folderPath = signal('');
  savingFolder = signal(false);
  loading = signal(false);
  error = signal('');

  private doneIds = computed(() => new Set(this.state().downloaded));
  private busyIds = computed(() => {
    const s = this.state();
    return new Set([
      ...s.queued,
      ...(s.active ?? (s.current ? [s.current] : [])).map((current) => current.id),
    ]);
  });

  visibleVideos = computed(() =>
    this.videos().slice(this.virtualStart(), this.virtualStart() + this.pageSize),
  );
  filteredSuggestionSections = computed(() => {
    const query = this.suggestionQuery().trim().toLocaleLowerCase();
    if (!query) return this.suggestions();
    return this.suggestions()
      .map((section) => {
        const sectionMatches = section.title.toLocaleLowerCase().includes(query);
        const subsections = section.subsections
          .map((subsection) => {
            const subsectionMatches = subsection.title.toLocaleLowerCase().includes(query);
            return {
              ...subsection,
              channels: subsection.channels.filter(
                (channel) =>
                  sectionMatches ||
                  subsectionMatches ||
                  channel.title.toLocaleLowerCase().includes(query),
              ),
            };
          })
          .filter((subsection) => subsection.channels.length);
        return { ...section, subsections };
      })
      .filter((section) => section.subsections.length);
  });
  visibleChannelVideos = computed(() =>
    this.importVideos().slice(
      this.channelVirtualStart(),
      this.channelVirtualStart() + this.pageSize,
    ),
  );
  channelVirtualBottom = computed(() =>
    Math.max(
      0,
      (this.importVideos().length -
        this.channelVirtualStart() -
        this.visibleChannelVideos().length) *
        this.channelRowHeight,
    ),
  );
  virtualBottom = computed(() =>
    Math.max(
      0,
      (this.videos().length - this.virtualStart() - this.visibleVideos().length) * this.rowHeight,
    ),
  );

  selectable = computed(() =>
    (this.page() === 'overview' ? this.visibleVideos() : this.importVideos()).filter(
      (v) => !this.doneIds().has(v.id) && !this.busyIds().has(v.id),
    ),
  );

  constructor() {
    this.http.get<Settings>(`${API}/settings`).subscribe({
      next: (settings) => {
        const dir = settings.downloadDir ?? '';
        this.storageLocationFixed.set(settings.downloadDirFixed === true);
        this.state.update((state) => ({ ...state, dir }));
        this.folderPath.set(dir);
        this.maxParallelDownloads.set(settings.maxParallelDownloads ?? 1);
        this.cookiesBrowser.set(settings.cookiesBrowser ?? 'chrome');
        this.language.set(settings.language === 'nl' ? 'nl' : 'en');
        this.state.update((state) => ({ ...state, syncEnabled: settings.syncEnabled ?? true }));
        this.settingsLoaded.set(true);
        if (dir) this.fetchVideoPage(0, false);
        this.loadChannels();
      },
      error: () => {
        this.error.set(
          this.t(
            'Cannot reach the backend at localhost:3000.',
            'Kan de backend niet bereiken op localhost:3000.',
          ),
        );
        this.settingsLoaded.set(true);
      },
    });
    this.loadSuggestions();
    // Houdt gedownload/wachtrij/voortgang actueel.
    interval(2000)
      .pipe(
        startWith(0),
        switchMap(() => this.http.get<State>(`${API}/state`).pipe(catchError(() => EMPTY))),
        takeUntilDestroyed(),
      )
      .subscribe((s) => {
        this.state.set(s);
        if (!this.folderPath() && s.dir) this.folderPath.set(s.dir);
        if (this.page() === 'sync-progress') this.loadSyncProgress();
        if (this.failureLogOpen()) this.loadFailureLog();
      });
  }

  searchCollection(value: string) {
    this.query.set(value);
    this.virtualStart.set(0);
    this.scrollTop.set(0);
    this.fetchVideoPage(0, false);
  }

  fetchVideoPage(offset: number, append: boolean) {
    if (append && this.loadingMore()) return;
    this.loadingMore.set(true);
    this.http
      .get<VideoPage>(`${API}/videos`, {
        params: { q: this.query(), offset, limit: this.pageSize },
      })
      .subscribe({
        next: (page) => {
          this.videos.set(append ? [...this.videos(), ...page.items] : page.items);
          this.totalVideos.set(page.total);
          this.hasMore.set(page.hasMore);
          this.loadingMore.set(false);
        },
        error: () => {
          this.error.set(
            this.t(
              'Could not load videos from the collection.',
              'Video’s uit de collectie laden is mislukt.',
            ),
          );
          this.loadingMore.set(false);
        },
      });
  }

  onVideoScroll(event: Event) {
    const el = event.target as HTMLElement;
    this.scrollTop.set(el.scrollTop);
    this.virtualStart.set(
      Math.min(
        Math.max(0, this.videos().length - this.pageSize),
        Math.floor(el.scrollTop / this.rowHeight),
      ),
    );
    if (
      this.hasMore() &&
      !this.loadingMore() &&
      el.scrollTop + el.clientHeight >= el.scrollHeight - this.rowHeight * 4
    ) {
      this.fetchVideoPage(this.videos().length, true);
    }
  }

  openPage(page: 'overview' | 'channels' | 'suggestions' | 'sync-progress' | 'import') {
    this.page.set(page);
    this.error.set('');
    if (page === 'overview') this.fetchVideoPage(0, false);
    if (page === 'channels') this.loadChannels();
    if (page === 'suggestions') {
      this.loadChannels();
      this.loadSuggestions();
    }
    if (page === 'sync-progress') this.loadSyncProgress();
  }

  loadSyncProgress() {
    this.http.get<ChannelSyncProgress[]>(`${API}/channels/progress`).subscribe({
      next: (progress) => this.syncProgress.set(progress),
      error: () =>
        this.error.set(this.t('Could not load sync progress.', 'Syncvoortgang laden is mislukt.')),
    });
  }

  toggleSync() {
    this.syncToggleLoading.set(true);
    this.http
      .patch<{ enabled: boolean; state: State }>(`${API}/sync`, {
        enabled: !this.state().syncEnabled,
      })
      .subscribe({
        next: (result) => {
          this.state.set(result.state);
          this.syncToggleLoading.set(false);
          this.loadSyncProgress();
        },
        error: (e) => {
          this.error.set(
            e.error?.message ??
              this.t('Could not change the sync setting.', 'Sync-instelling wijzigen is mislukt.'),
          );
          this.syncToggleLoading.set(false);
        },
      });
  }

  openFailureLog() {
    this.failureLogOpen.set(true);
    this.loadFailureLog();
  }

  closeFailureLog() {
    this.failureLogOpen.set(false);
  }

  loadFailureLog() {
    this.http
      .get<{ lines: string[] }>(`${API}/sync/failures`, { params: { lines: 1000 } })
      .subscribe({
        next: (result) => this.failureLog.set(result.lines),
        error: () =>
          this.error.set(this.t('Could not load the failure log.', 'Faallog laden is mislukt.')),
      });
  }

  loadChannels() {
    this.http.get<Channel[]>(`${API}/channels`).subscribe({
      next: (channels) => this.channels.set(channels),
      error: () =>
        this.error.set(
          this.t('Could not load saved channels.', 'Kan de opgeslagen kanalen niet laden.'),
        ),
    });
  }

  loadSuggestions() {
    this.suggestionsLoading.set(true);
    this.http.get<SuggestionSection[]>(`${API}/suggestions`).subscribe({
      next: (suggestions) => {
        this.suggestions.set(suggestions);
        this.suggestionsLoading.set(false);
      },
      error: () => {
        this.suggestionsLoading.set(false);
        this.error.set(
          this.t('Could not load channel suggestions.', 'Kan de kanaalsuggesties niet laden.'),
        );
      },
    });
  }

  isSuggestionAdded(suggestion: Suggestion) {
    return this.channels().some((channel) => channel.url === suggestion.url);
  }

  addSuggestedChannel(suggestion: Suggestion) {
    if (this.isSuggestionAdded(suggestion) || this.addingSuggestionUrl()) return;
    this.addingSuggestionUrl.set(suggestion.url);
    this.error.set('');
    this.http.post<{ channels: Channel[] }>(`${API}/channels`, { url: suggestion.url }).subscribe({
      next: (result) => {
        this.channels.set(result.channels);
        this.addingSuggestionUrl.set(null);
      },
      error: (e) => {
        this.error.set(
          e.error?.message ??
            this.t('Could not add this channel.', 'Dit kanaal toevoegen is mislukt.'),
        );
        this.addingSuggestionUrl.set(null);
      },
    });
  }

  startChannelDrag(channel: Channel, event: DragEvent) {
    this.draggedChannelUrl.set(channel.url);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', channel.url);
    }
  }

  dropChannel(target: Channel, event: DragEvent) {
    event.preventDefault();
    const sourceUrl = this.draggedChannelUrl() ?? event.dataTransfer?.getData('text/plain');
    if (!sourceUrl || sourceUrl === target.url || this.channelReordering()) return;
    const previous = this.channels();
    const reordered = [...previous];
    const sourceIndex = reordered.findIndex((channel) => channel.url === sourceUrl);
    if (sourceIndex < 0) return;
    reordered.splice(sourceIndex, 1);
    const targetIndex = reordered.findIndex((channel) => channel.url === target.url);
    const targetElement = event.currentTarget as HTMLElement;
    const targetBounds = targetElement.getBoundingClientRect();
    const dropAfter = event.clientY > targetBounds.top + targetBounds.height / 2;
    reordered.splice(targetIndex + (dropAfter ? 1 : 0), 0, previous[sourceIndex]);
    this.channels.set(reordered);
    this.channelReordering.set(true);
    this.http
      .patch<Channel[]>(`${API}/channels/order`, { urls: reordered.map((channel) => channel.url) })
      .subscribe({
        next: (channels) => {
          this.channels.set(channels);
          this.channelReordering.set(false);
        },
        error: () => {
          this.channels.set(previous);
          this.channelReordering.set(false);
          this.error.set(
            this.t('Could not save the channel order.', 'Kanaalvolgorde opslaan is mislukt.'),
          );
        },
      });
  }

  addChannel(url = this.channelUrl().trim()) {
    if (!url) return;
    this.addingChannel.set(true);
    this.syncingChannelUrl.set(url);
    this.error.set('');
    this.channelScanMessage.set('');
    this.http.post<{ channels: Channel[] }>(`${API}/channels`, { url }).subscribe({
      next: (result) => {
        this.channels.set(result.channels);
        this.channelUrl.set('');
        this.channelScanMessage.set(
          this.t(
            'Channel added. Auto-sync is off by default.',
            'Kanaal toegevoegd. Auto-sync staat standaard uit.',
          ),
        );
        this.addingChannel.set(false);
        this.syncingChannelUrl.set('');
      },
      error: (e) => {
        this.error.set(
          e.error?.message ?? this.t('Could not add the channel.', 'Kanaal toevoegen is mislukt.'),
        );
        this.addingChannel.set(false);
        this.syncingChannelUrl.set('');
      },
    });
  }

  toggleAutoSync(channel: Channel, enabled: boolean) {
    this.syncingChannelUrl.set(channel.url);
    this.error.set('');
    this.http
      .patch<{ channels: Channel[]; scanned: number; queued: number }>(`${API}/channels/autosync`, {
        url: channel.url,
        enabled,
      })
      .subscribe({
        next: (result) => {
          this.channels.set(result.channels);
          this.channelScanMessage.set(
            enabled
              ? this.t(
                  `${result.scanned} videos checked. Undownloaded videos were added to the sync queue.`,
                  `${result.scanned} video’s gecontroleerd. Niet gedownloade video’s zijn in de syncwachtrij gezet.`,
                )
              : this.t('Auto-sync is off.', 'Auto-sync staat uit.'),
          );
          this.syncingChannelUrl.set('');
        },
        error: (e) => {
          this.error.set(
            e.error?.message ??
              this.t(
                'Could not save the auto-sync setting.',
                'Auto-sync-instelling opslaan is mislukt.',
              ),
          );
          this.syncingChannelUrl.set('');
        },
      });
  }

  removeChannel(channel: Channel) {
    this.http.delete<Channel[]>(`${API}/channels`, { params: { url: channel.url } }).subscribe({
      next: (channels) => this.channels.set(channels),
      error: () =>
        this.error.set(this.t('Could not remove the channel.', 'Kanaal verwijderen is mislukt.')),
    });
  }

  playVideo(video: Video) {
    this.playingVideo.set(video);
  }

  closePlayer() {
    this.playingVideo.set(null);
  }

  applySubtitleLanguage(video: HTMLVideoElement) {
    const preferredLanguage = this.language();
    let selected = false;
    for (const track of Array.from(video.textTracks)) {
      const matches =
        track.language.toLocaleLowerCase() === preferredLanguage ||
        track.language.toLocaleLowerCase().startsWith(`${preferredLanguage}-`);
      track.mode = matches && !selected ? 'showing' : 'disabled';
      if (matches) selected = true;
    }
  }

  loadChannel(url: string) {
    this.loading.set(true);
    this.error.set('');
    this.selected.set(new Set());
    this.importVideos.set([]);
    this.channelTotal.set(0);
    this.channelHasMore.set(false);
    this.channelVirtualStart.set(0);
    this.fetchChannelPage(url, 0, false);
  }

  fetchChannelPage(url: string, offset: number, append: boolean) {
    if (append && this.channelPageLoading()) return;
    this.channelPageLoading.set(true);
    this.http
      .get<VideoPage>(`${API}/channels/videos`, { params: { url, offset, limit: this.pageSize } })
      .subscribe({
        next: (page) => {
          if (page.scanning) {
            window.setTimeout(() => {
              if (this.selectedChannel()?.url === url) this.fetchChannelPage(url, offset, append);
            }, 400);
            return;
          }
          this.importVideos.set(append ? [...this.importVideos(), ...page.items] : page.items);
          this.channelTotal.set(page.total);
          this.channelHasMore.set(page.hasMore);
          this.channelPageLoading.set(false);
          this.loading.set(false);
        },
        error: (e) => {
          this.importVideos.set([]);
          this.error.set(
            e.error?.message ??
              this.t(
                'Could not load videos from this channel.',
                'Video’s van dit kanaal laden is mislukt.',
              ),
          );
          this.loading.set(false);
          this.channelPageLoading.set(false);
        },
      });
  }

  onChannelScroll(event: Event) {
    const el = event.target as HTMLElement;
    this.channelVirtualStart.set(
      Math.min(
        Math.max(0, this.importVideos().length - this.pageSize),
        Math.floor(el.scrollTop / this.channelRowHeight),
      ),
    );
    if (
      this.channelHasMore() &&
      !this.channelPageLoading() &&
      el.scrollTop + el.clientHeight >= el.scrollHeight - this.channelRowHeight * 4
    ) {
      const url = this.selectedChannel()?.url;
      if (url) this.fetchChannelPage(url, this.importVideos().length, true);
    }
  }

  openChannel(channel: Channel) {
    this.selectedChannel.set(channel);
    this.page.set('import');
    this.loadChannel(channel.url);
  }

  saveFolder() {
    this.savingFolder.set(true);
    this.error.set('');
    this.http
      .post<Settings>(`${API}/settings`, {
        downloadDir: this.folderPath().trim(),
        maxParallelDownloads: this.maxParallelDownloads(),
        cookiesBrowser: this.cookiesBrowser(),
        language: this.language(),
      })
      .subscribe({
        next: (settings) => {
          const dir = settings.downloadDir ?? '';
          this.storageLocationFixed.set(settings.downloadDirFixed === true);
          this.state.update((state) => ({ ...state, dir }));
          this.folderPath.set(dir);
          this.maxParallelDownloads.set(settings.maxParallelDownloads ?? 1);
          this.cookiesBrowser.set(settings.cookiesBrowser ?? 'chrome');
          this.language.set(settings.language === 'nl' ? 'nl' : 'en');
          this.settingsOpen.set(false);
          this.savingFolder.set(false);
        },
        error: (e) => {
          this.error.set(
            e.error?.message ??
              this.t('Could not save settings.', 'Instellingen opslaan is mislukt.'),
          );
          this.savingFolder.set(false);
        },
      });
  }

  isDone(id: string) {
    return this.doneIds().has(id);
  }
  isBusy(id: string) {
    return this.busyIds().has(id);
  }

  toggle(id: string) {
    const next = new Set(this.selected());
    next.has(id) ? next.delete(id) : next.add(id);
    this.selected.set(next);
  }

  selectVisible() {
    this.selected.set(new Set([...this.selected(), ...this.selectable().map((v) => v.id)]));
  }

  download() {
    const ids = [...this.selected()];
    this.http.post<State>(`${API}/download`, { ids }).subscribe({
      next: (s) => {
        this.state.set(s);
        this.selected.set(new Set());
      },
      error: (e) => this.error.set(e.error?.message ?? 'Downloaden starten is mislukt.'),
    });
  }

  badge(id: string) {
    const s = this.state();
    if (this.isDone(id)) return this.t('Downloaded', 'Gedownload');
    const active =
      s.active?.find((item) => item.id === id) ?? (s.current?.id === id ? s.current : null);
    if (active) return `${active.progress}%`;
    if (s.queued.includes(id)) return this.t('Queued', 'In wachtrij');
    if (s.failed.includes(id)) return this.t('Failed', 'Mislukt');
    return '';
  }

  badgeClass(id: string) {
    const s = this.state();
    return (
      'badge ' +
      (this.isDone(id)
        ? 'done'
        : s.failed.includes(id)
          ? 'failed'
          : this.isBusy(id)
            ? 'active'
            : '')
    );
  }

  fmt(sec: number | null) {
    if (sec == null) return '';
    const h = Math.floor(sec / 3600),
      m = Math.floor((sec % 3600) / 60),
      s = Math.floor(sec % 60);
    const pad = (n: number) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  t(english: string, dutch: string) {
    return this.language() === 'nl' ? dutch : english;
  }

  retryMinutes() {
    const retryAt = this.state().retryAt;
    return retryAt ? Math.max(1, Math.ceil((retryAt - Date.now()) / 60_000)) : 0;
  }

  isRateLimitCoolingDown() {
    const retryAt = this.state().retryAt;
    return typeof retryAt === 'number' && retryAt > Date.now();
  }
}

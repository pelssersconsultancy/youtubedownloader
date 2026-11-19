import { Component, inject, signal, OnInit } from '@angular/core';
import { AppStateService } from '../../core/services/app-state.service';
import { SyncApiService } from '../../core/services/sync-api.service';
import { ChannelApiService } from '../../core/services/channel-api.service';
import type { ChannelSyncProgress } from '../../core/models/channel.model';

@Component({
  selector: 'app-sync-progress',
  standalone: true,
  template: `
    <section class="sync-progress-page" aria-live="polite">
      <div class="sync-controls">
        <p class="count">
          {{ t('Updates every 2 seconds.', 'Wordt automatisch elke 2 seconden bijgewerkt.') }}
          {{
            appState.state().syncEnabled
              ? t('Sync is active.', 'Synchronisatie is actief.')
              : t('Sync is paused.', 'Synchronisatie is gepauzeerd.')
          }}
        </p>
        <div class="sync-actions">
          <button type="button" [disabled]="toggleLoading()" (click)="toggleSync()">
            {{
              toggleLoading()
                ? t('Working…', 'Bezig…')
                : appState.state().syncEnabled
                  ? t('Stop syncing', 'Stop synchroniseren')
                  : t('Start syncing', 'Start synchroniseren')
            }}
          </button>
          <button type="button" class="ghost log-btn" (click)="openLog()">
            {{ t('Failure log', 'Faallog') }}
          </button>
        </div>
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
      @if (appState.state().subtitleRetrying?.length) {
        <p class="count">
          {{ appState.state().subtitleRetrying?.length ?? 0 }}
          {{
            t('subtitle jobs waiting for retry.', 'ondertiteljobs wachten op een nieuwe poging.')
          }}
        </p>
      }

      @for (channel of progress(); track channel.url) {
        <article class="channel-progress-card">
          <div class="channel-progress-heading">
            <div>
              <h2>{{ channel.title }}</h2>
              <small>
                {{ channel.completed }} / {{ channel.total }}
                {{ t('videos complete', "video's gereed") }}
              </small>
            </div>
            <span>{{ channel.percent }}%</span>
          </div>
          <progress class="channel-progress-bar" [value]="channel.percent" max="100"></progress>
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
                    <progress [value]="video.progress" max="100"></progress>
                    <span>{{ video.progress }}%</span>
                  </div>
                </div>
              </article>
            }
          }
          @if (channel.queued.length) {
            <h3>{{ t('Queue', 'Wachtrij') }} &middot; {{ channel.queued.length }}</h3>
            @for (video of channel.queued.slice(0, 5); track video.id) {
              <article class="sync-video queued-video">
                <img
                  [src]="video.thumbnail"
                  [alt]="t('Thumbnail: ', 'Thumbnail: ') + video.title"
                  width="120"
                  height="68"
                />
                <div class="sync-info">
                  <strong>{{ video.title }}</strong>
                  <span>{{ queuedStatus(video.id) }}</span>
                </div>
              </article>
            }
          }
          @if (channel.failed.length) {
            <p class="error">
              {{ channel.failed.length }} {{ t('videos failed.', "video's zijn mislukt.") }}
            </p>
          }
        </article>
      } @empty {
        <p class="empty">
          {{ t('There are no bookmarked channels yet.', 'Er zijn nog geen gebookmarkte kanalen.') }}
        </p>
      }

      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }

      @if (logOpen()) {
        <div class="failure-backdrop" (click)="closeLog()" (keydown.escape)="closeLog()">
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
                (click)="closeLog()"
              >
                &times;
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
    </section>
  `,
  styles: [
    `
      .sync-controls {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 14px;
        flex-wrap: wrap;
      }
      .sync-actions {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .log-btn {
        font-size: 12px;
        padding: 8px 14px;
      }
      .rate-limit-notice {
        margin-bottom: 14px;
      }
      .channel-progress-card {
        margin: 16px 0;
        padding: 20px;
        border: 1px solid var(--line);
        border-radius: 13px;
        background: linear-gradient(135deg, rgba(17, 26, 47, 0.94), rgba(13, 19, 36, 0.88));
        box-shadow: 0 15px 40px rgba(0, 0, 0, 0.15);
      }
      .channel-progress-heading {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      .channel-progress-heading h2 {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
      }
      .channel-progress-heading small {
        color: var(--muted);
      }
      .channel-progress-heading > span {
        font-size: 20px;
        font-weight: 700;
        color: #61ddfa;
        text-shadow: 0 0 15px rgba(72, 217, 255, 0.3);
      }
      .channel-progress-bar {
        display: block;
        width: 100%;
        height: 10px;
        margin: 10px 0;
        border-radius: 10px;
        accent-color: #5ddfff;
      }
      .channel-progress-card h3 {
        margin: 14px 0 0;
        color: #aebdd5;
        font-size: 10px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .sync-video {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 9px 0;
        border-top: 1px solid var(--line);
      }
      .sync-video img {
        flex: 0 0 auto;
        width: 120px;
        height: 68px;
        border-radius: 5px;
        border: 1px solid var(--line);
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
      .sync-info > span {
        color: var(--muted);
        font-size: 13px;
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
      .failure-backdrop {
        position: fixed;
        inset: 0;
        z-index: 20;
        display: grid;
        place-items: center;
        padding: 24px;
        background: rgb(0 0 0 / 65%);
        backdrop-filter: blur(12px);
      }
      .failure-dialog {
        width: min(100%, 900px);
        border: 1px solid rgba(130, 171, 235, 0.23);
        border-radius: 14px;
        padding: 0;
        background: #0e172b;
        color: var(--ink);
        box-shadow: 0 28px 100px rgba(0, 0, 0, 0.56);
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
        color: #b5cae8;
        font:
          12px/1.5 ui-monospace,
          SFMono-Regular,
          Menlo,
          monospace;
      }
      .close-player {
        padding: 2px 12px;
        font-size: 25px;
        line-height: 1.2;
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
      @media (max-width: 600px) {
        .sync-controls {
          align-items: flex-start;
          flex-direction: column;
        }
      }
    `,
  ],
})
export class SyncProgressComponent implements OnInit {
  appState = inject(AppStateService);
  private syncApi = inject(SyncApiService);
  private channelApi = inject(ChannelApiService);

  progress = signal<ChannelSyncProgress[]>([]);
  toggleLoading = signal(false);
  logOpen = signal(false);
  failureLog = signal<string[]>([]);
  error = signal('');

  ngOnInit() {
    this.loadProgress();
    const intervalId = setInterval(() => {
      if (document.visibilityState !== 'hidden') this.loadProgress();
    }, 2000);
    this.onDestroy = () => clearInterval(intervalId);
  }

  private onDestroy?: () => void;

  ngOnDestroy() {
    this.onDestroy?.();
  }

  t(english: string, dutch: string) {
    return this.appState.t(english, dutch);
  }

  loadProgress() {
    this.channelApi.getProgress().subscribe({
      next: (p) => this.progress.set(p),
      error: () =>
        this.error.set(this.t('Could not load sync progress.', 'Syncvoortgang laden is mislukt.')),
    });
  }

  toggleSync() {
    this.toggleLoading.set(true);
    this.syncApi.toggleSync(!this.appState.state().syncEnabled).subscribe({
      next: (result) => {
        this.appState.state.set(result.state);
        this.toggleLoading.set(false);
        this.loadProgress();
      },
      error: (e) => {
        this.error.set(
          e.error?.message ??
            this.t('Could not change the sync setting.', 'Sync-instelling wijzigen is mislukt.'),
        );
        this.toggleLoading.set(false);
      },
    });
  }

  openLog() {
    this.logOpen.set(true);
    this.syncApi.getFailureLog().subscribe({
      next: (r) => this.failureLog.set(r.lines),
      error: () =>
        this.error.set(this.t('Could not load the failure log.', 'Faallog laden is mislukt.')),
    });
  }

  closeLog() {
    this.logOpen.set(false);
  }

  queuedStatus(id: string) {
    const retry = this.appState.state().retrying?.find((job) => job.id === id);
    if (!retry) return this.t('Queued', 'In wachtrij');
    const remaining = Math.max(0, (retry.nextAttemptAt ?? Date.now()) - Date.now());
    const time =
      remaining >= 60_000
        ? `${Math.ceil(remaining / 60_000)} min`
        : `${Math.ceil(remaining / 1000)} sec`;
    return `${this.t('Retry in', 'Opnieuw over')} ${time}`;
  }

  retryMinutes() {
    const retryAt = this.appState.state().retryAt;
    return retryAt ? Math.max(1, Math.ceil((retryAt - Date.now()) / 60_000)) : 0;
  }

  isRateLimitCoolingDown() {
    const retryAt = this.appState.state().retryAt;
    return typeof retryAt === 'number' && retryAt > Date.now();
  }
}

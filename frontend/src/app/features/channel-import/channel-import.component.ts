import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AppStateService } from '../../core/services/app-state.service';
import { ChannelApiService } from '../../core/services/channel-api.service';
import { VideoApiService } from '../../core/services/video-api.service';
import type { Video } from '../../core/models/video.model';

@Component({
  selector: 'app-channel-import',
  standalone: true,
  template: `
    <p class="count">
      {{ channelTotal() }} {{ t('videos in this channel', "video’s in dit kanaal") }} &middot;
      {{ videos().length }} {{ t('loaded', 'geladen') }}
    </p>

    <div class="video-scroll import-scroll" (scroll)="onScroll($event)">
      <ul class="import-list">
        @if (virtualStart() > 0) {
          <li class="spacer" [style.height.px]="virtualStart() * rowHeight"></li>
        }
        @for (v of visible(); track v.id) {
          <li class="import-video-row">
            <label [class.done]="isDone(v.id)">
              <input
                type="checkbox"
                [checked]="isDone(v.id) || isBusy(v.id) || selected().has(v.id)"
                [disabled]="isDone(v.id) || isBusy(v.id)"
                (change)="toggle(v.id)"
              />
              <img [src]="v.thumbnail" alt="" loading="lazy" width="120" height="68" />
              <span class="title">{{ v.title }}</span>
              <span class="dur">{{ fmt(v.duration) }}</span>
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
                  "Geen video's gevonden voor dit kanaal."
                )
              }}
            </li>
          }
        }
        @if (virtualBottom() > 0) {
          <li class="spacer" [style.height.px]="virtualBottom()"></li>
        }
      </ul>
      @if (pageLoading() && videos().length) {
        <p class="loading-more">{{ t('Loading more videos…', "Volgende video's laden…") }}</p>
      }
    </div>

    @if (selected().size) {
      <button type="button" class="import-download" (click)="download()">
        {{ t('Download', 'Download') }} {{ selected().size }}
        {{ t('selected', 'geselecteerd') }}
      </button>
    }

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
  `,
  styles: [
    `
      .import-scroll {
        position: relative;
        height: calc(100vh - 210px);
        min-height: 300px;
        overflow: auto;
        border-radius: 8px;
      }
      .import-list {
        margin-top: 0;
        min-height: 100%;
      }
      .import-video-row {
        height: 86px;
        box-sizing: border-box;
        overflow: hidden;
        border-top: 1px solid var(--line);
      }
      .import-video-row:first-child {
        border-top: none;
      }
      label {
        display: grid;
        grid-template-columns: auto 120px 1fr auto auto;
        gap: 12px;
        align-items: center;
        padding: 8px 12px;
        cursor: pointer;
        height: 100%;
        box-sizing: border-box;
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
        color: #5de0c0;
        font-weight: 600;
      }
      .badge.failed {
        color: #ff7396;
        font-weight: 600;
      }
      .badge.active {
        color: #61ddfa;
        font-weight: 600;
      }
      .import-download {
        margin-top: 12px;
      }
      ::-webkit-scrollbar { width: 9px; height: 9px; }
      ::-webkit-scrollbar-track { background: rgba(4, 9, 19, 0.4); }
      ::-webkit-scrollbar-thumb { border: 2px solid #0a1020; border-radius: 8px; background: #334565; }
      ::-webkit-scrollbar-thumb:hover { background: #4e709a; }
      @media (max-width: 600px) {
        label { grid-template-columns: auto 1fr; }
        img, .dur { display: none; }
        .badge { grid-column: 2; text-align: left; }
      }
    `,
  ],
})
export class ChannelImportComponent implements OnInit {
  appState = inject(AppStateService);
  private channelApi = inject(ChannelApiService);
  private videoApi = inject(VideoApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  videos = signal<Video[]>([]);
  channelTotal = signal(0);
  hasMore = signal(false);
  pageLoading = signal(false);
  loading = signal(false);
  selected = signal<ReadonlySet<string>>(new Set());
  virtualStart = signal(0);
  error = signal('');

  readonly rowHeight = 86;
  readonly pageSize = 20;

  private channelUrl = '';

  private doneIds = computed(() => new Set(this.appState.state().downloaded));
  private busyIds = computed(() => {
    const s = this.appState.state();
    return new Set([
      ...s.queued,
      ...(s.active ?? (s.current ? [s.current] : [])).map((item) => item.id),
    ]);
  });

  visible = computed(() =>
    this.videos().slice(this.virtualStart(), this.virtualStart() + this.pageSize),
  );

  virtualBottom = computed(() =>
    Math.max(
      0,
      (this.videos().length - this.virtualStart() - this.visible().length) * this.rowHeight,
    ),
  );

  ngOnInit() {
    const url = this.route.snapshot.queryParamMap.get('url');
    if (!url) {
      this.router.navigate(['/channels']);
      return;
    }
    this.channelUrl = url;
    this.fetchPage(0, false);
  }

  t(english: string, dutch: string) {
    return this.appState.t(english, dutch);
  }

  fetchPage(offset: number, append: boolean) {
    if (append && this.pageLoading()) return;
    this.pageLoading.set(true);
    if (!append) this.loading.set(true);
    this.channelApi.getChannelVideos(this.channelUrl, offset, this.pageSize).subscribe({
      next: (page) => {
        if (page.scanning) {
          window.setTimeout(() => this.fetchPage(offset, append), 400);
          return;
        }
        this.videos.set(append ? [...this.videos(), ...page.items] : page.items);
        this.channelTotal.set(page.total);
        this.hasMore.set(page.hasMore);
        this.pageLoading.set(false);
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(
          e.error?.message ??
            this.t(
              'Could not load videos from this channel.',
              "Video's van dit kanaal laden is mislukt.",
            ),
        );
        this.pageLoading.set(false);
        this.loading.set(false);
      },
    });
  }

  onScroll(event: Event) {
    const el = event.target as HTMLElement;
    this.virtualStart.set(
      Math.min(
        Math.max(0, this.videos().length - this.pageSize),
        Math.floor(el.scrollTop / this.rowHeight),
      ),
    );
    if (
      this.hasMore() &&
      !this.pageLoading() &&
      el.scrollTop + el.clientHeight >= el.scrollHeight - this.rowHeight * 4
    ) {
      this.fetchPage(this.videos().length, true);
    }
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

  download() {
    const ids = [...this.selected()];
    this.videoApi.download(ids).subscribe({
      next: (s) => {
        this.appState.state.set(s);
        this.selected.set(new Set());
      },
      error: (e) =>
        this.error.set(e.error?.message ?? this.t('Download failed.', 'Downloaden starten is mislukt.')),
    });
  }

  badge(id: string) {
    const s = this.appState.state();
    if (this.isDone(id)) return this.t('Downloaded', 'Gedownload');
    const active =
      s.active?.find((item) => item.id === id) ?? (s.current?.id === id ? s.current : null);
    if (active) return `${active.progress}%`;
    if (s.queued.includes(id)) return this.queuedStatus(id);
    if (s.failed.includes(id)) return this.t('Failed', 'Mislukt');
    return '';
  }

  badgeClass(id: string) {
    const s = this.appState.state();
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

  fmt(sec: number | null) {
    if (sec == null) return '';
    const h = Math.floor(sec / 3600),
      m = Math.floor((sec % 3600) / 60),
      s = Math.floor(sec % 60);
    const pad = (n: number) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
}

import { Component, inject, signal, computed } from '@angular/core';
import { AppStateService } from '../../core/services/app-state.service';
import { VideoApiService } from '../../core/services/video-api.service';
import type { Video } from '../../core/models/video.model';

@Component({
  selector: 'app-overview',
  standalone: true,
  template: `
    <section class="hero-banner">
      <div class="hero-copy">
        <span class="eyebrow">{{ t('PERSONAL VIDEO ARCHIVE', 'PERSOONLIJK VIDEOARCHIEF') }}</span>
        <h2>
          {{ t('Your collection,', 'Jouw collectie,') }}<br /><span>{{
            t('in motion.', 'in beweging.')
          }}</span>
        </h2>
        <p>{{ t('One place for every story you have saved.', 'Alle video’s die je hebt bewaard, op één plek.') }}</p>
      </div>
      <div class="hero-orbit" aria-hidden="true">
        <div class="orbit-core">&#9654;</div>
        <i></i><b></b><em></em><span></span>
      </div>
      <div class="hero-index">
        <span>{{ t('LIBRARY INDEX', 'COLLECTIE-INDEX') }}</span>
        <strong>{{ totalVideos() }}</strong>
        <small>{{ t('VIDEOS', 'VIDEO’S') }}</small>
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
    <p class="count">{{ totalVideos() }} {{ t('downloaded videos', 'gedownloade video’s') }}</p>

    <div class="video-scroll" (scroll)="onScroll($event)">
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
              (click)="play(v)"
              (keydown.enter)="play(v)"
              (keydown.space)="play(v); $event.preventDefault()"
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
              {{ t('No videos have been downloaded yet.', 'Er zijn nog geen video’s gedownload.') }}
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

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
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
              &times;
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
              [default]="appState.language() === 'en'"
              (load)="applySubtitleLanguage(player)"
            />
            <track
              kind="subtitles"
              [src]="subtitleUrl('nl')"
              srclang="nl"
              label="Nederlands"
              [default]="appState.language() === 'nl'"
              (load)="applySubtitleLanguage(player)"
            />
          </video>
        </section>
      </div>
    }
  `,
  styles: [
    `
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
        font: 9px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
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
      .hero-orbit i { left: 25px; top: 40px; }
      .hero-orbit b { right: 22px; top: 75px; background: #e787ff; box-shadow: 0 0 13px #e787ff; }
      .hero-orbit em { bottom: 19px; left: 76px; background: #fff; }
      .hero-orbit span { top: 23px; right: 64px; width: 4px; height: 4px; }
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
      .video-scroll {
        position: relative;
        height: calc(100vh - 420px);
        min-height: 280px;
        overflow: auto;
        border-radius: 8px;
      }
      .video-scroll ul {
        min-height: 100%;
      }
      .video-row {
        height: 150px;
        box-sizing: border-box;
        overflow: hidden;
        padding: 10px;
        border-color: rgba(129, 164, 220, 0.11);
      }
      .video-card {
        display: flex;
        align-items: center;
        gap: 18px;
        height: 100%;
        overflow: hidden;
        cursor: pointer;
        border: 1px solid transparent;
        border-radius: 7px;
        padding: 0 10px;
        transition: background-color 120ms ease;
      }
      .video-row:hover .video-card {
        border-color: rgba(72, 217, 255, 0.19);
        background: linear-gradient(90deg, rgba(72, 217, 255, 0.075), rgba(136, 78, 202, 0.045));
      }
      .video-card:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
      }
      .video-card img {
        width: 180px;
        height: 102px;
        flex: 0 0 auto;
        border: 1px solid rgba(161, 192, 245, 0.16);
        border-radius: 8px;
        box-shadow: 0 8px 25px rgba(0, 0, 0, 0.25);
      }
      .video-info {
        min-width: 0;
      }
      .video-info h2 {
        margin: 0;
        font-size: 15px;
        font-weight: 570;
        letter-spacing: -0.012em;
        line-height: 1.35;
      }
      .video-info .dur {
        margin: 6px 0;
      }
      .keywords {
        margin: 6px 0 0;
        color: #7688a5;
        font-size: 11px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .player-backdrop {
        position: fixed;
        inset: 0;
        z-index: 10;
        display: grid;
        place-items: center;
        padding: 24px;
        background: rgb(0 0 0 / 72%);
        backdrop-filter: blur(12px);
      }
      .player-dialog {
        width: min(100%, 1000px);
        overflow: hidden;
        border: 1px solid rgba(130, 171, 235, 0.23);
        border-radius: 14px;
        background: #0e172b;
        color: var(--ink);
        box-shadow: 0 28px 100px rgba(0, 0, 0, 0.56);
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
      @media (max-width: 600px) {
        .hero-banner {
          min-height: 207px;
          padding: 22px 18px;
        }
        .hero-copy h2 { font-size: 30px; }
        .hero-copy p { max-width: 200px; font-size: 10px; }
        .hero-orbit { left: 77%; transform: translate(-50%, -50%) scale(0.58); }
        .hero-index { display: none; }
        .video-scroll { height: calc(100vh - 390px); min-height: 260px; }
        .video-row { padding: 7px; }
        .video-card { padding: 0 5px; }
        .video-card img { width: 96px; height: 58px; }
        .video-info h2 { font-size: 12px; }
        .video-info .dur { font-size: 10px; }
        .keywords { display: none; }
      }
      @media (max-width: 800px) {
        .hero-orbit { left: 69%; transform: translate(-50%, -50%) scale(0.8); }
      }
    `,
  ],
})
export class OverviewComponent {
  appState = inject(AppStateService);
  private videoApi = inject(VideoApiService);

  query = signal('');
  videos = signal<Video[]>([]);
  totalVideos = signal(0);
  hasMore = signal(false);
  loadingMore = signal(false);
  virtualStart = signal(0);
  playingVideo = signal<Video | null>(null);
  error = signal('');

  readonly rowHeight = 150;
  readonly pageSize = 20;


  visibleVideos = computed(() =>
    this.videos().slice(this.virtualStart(), this.virtualStart() + this.pageSize),
  );

  virtualBottom = computed(() =>
    Math.max(
      0,
      (this.videos().length - this.virtualStart() - this.visibleVideos().length) * this.rowHeight,
    ),
  );

  videoStreamUrl = computed(() => {
    const video = this.playingVideo();
    return video ? this.videoApi.videoStreamUrl(video.id) : '';
  });

  constructor() {
    this.fetch(0, false);
  }

  t(english: string, dutch: string) {
    return this.appState.t(english, dutch);
  }

  searchCollection(value: string) {
    this.query.set(value);
    this.virtualStart.set(0);
    this.fetch(0, false);
  }

  fetch(offset: number, append: boolean) {
    if (append && this.loadingMore()) return;
    this.loadingMore.set(true);
    this.videoApi.getVideos(this.query(), offset, this.pageSize).subscribe({
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
      !this.loadingMore() &&
      el.scrollTop + el.clientHeight >= el.scrollHeight - this.rowHeight * 4
    ) {
      this.fetch(this.videos().length, true);
    }
  }

  play(video: Video) {
    this.playingVideo.set(video);
  }

  closePlayer() {
    this.playingVideo.set(null);
  }

  subtitleUrl(language: 'en' | 'nl') {
    const video = this.playingVideo();
    return video ? this.videoApi.subtitleUrl(video.id, language) : '';
  }

  applySubtitleLanguage(video: HTMLVideoElement) {
    const preferredLanguage = this.appState.language();
    let selected = false;
    for (const track of Array.from(video.textTracks)) {
      const matches =
        track.language.toLocaleLowerCase() === preferredLanguage ||
        track.language.toLocaleLowerCase().startsWith(`${preferredLanguage}-`);
      track.mode = matches && !selected ? 'showing' : 'disabled';
      if (matches) selected = true;
    }
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

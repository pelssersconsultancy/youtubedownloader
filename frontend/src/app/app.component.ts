import { Component, inject, signal, computed, effect } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet, Router, NavigationEnd } from '@angular/router';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { AppStateService } from './core/services/app-state.service';
import { SettingsApiService } from './core/services/settings-api.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  template: `
    <div class="layout">
      <aside class="sidebar" aria-label="{{ t('Main navigation', 'Hoofdnavigatie') }}">
        <div class="brand">{{ t('Survival library', 'Overlevings Bibliotheek') }}</div>
        <a routerLink="/overview" routerLinkActive="active" class="nav-item">
          &#9638; <span>{{ t('Overview', 'Overzicht') }}</span>
        </a>
        <a routerLink="/channels" routerLinkActive="active" class="nav-item">
          &#9636; <span>{{ t('My Channels', 'Mijn kanalen') }}</span>
        </a>
        <a routerLink="/suggestions" routerLinkActive="active" class="nav-item">
          &#10023; <span>{{ t('Suggestions', 'Suggesties') }}</span>
        </a>
        <a routerLink="/sync" routerLinkActive="active" class="nav-item">
          &#9716; <span>{{ t('Sync progress', 'Syncvoortgang') }}</span>
        </a>
      </aside>

      <main>
        <header>
          <h1>{{ pageTitle() }}</h1>
          @if (appState.state().dir) {
            <p class="dir">{{ t('Saving to', 'Opslaan in') }} {{ appState.state().dir }}</p>
          }
          <button
            type="button"
            class="settings"
            [attr.aria-label]="t('Open settings', 'Instellingen openen')"
            [attr.title]="t('Settings', 'Instellingen')"
            (click)="settingsOpen.set(!settingsOpen())"
          >
            &#9881;
          </button>
        </header>

        @if (appState.settingsLoaded() && (!appState.state().dir || settingsOpen())) {
          <section class="setup">
            <h2>
              {{
                appState.state().dir
                  ? t('Settings', 'Instellingen')
                  : t('Choose a storage folder', 'Kies een opslagmap')
              }}
            </h2>
            <p>
              @if (appState.storageLocationFixed()) {
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
                    "Vul het volledige pad in van de map waarin je video's wilt bewaren."
                  )
                }}
              }
            </p>
            <form class="bar" (submit)="$event.preventDefault(); saveSettings()">
              @if (!appState.storageLocationFixed()) {
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
              <button
                type="submit"
                [disabled]="saving() || (!appState.storageLocationFixed() && !folderPath().trim())"
              >
                {{
                  saving()
                    ? t('Saving…', 'Opslaan…')
                    : t('Save settings', 'Instellingen opslaan')
                }}
              </button>
              @if (appState.state().dir) {
                <button type="button" class="ghost" (click)="settingsOpen.set(false)">
                  {{ t('Cancel', 'Annuleren') }}
                </button>
              }
            </form>
            <label class="setting-field">
              {{ t('Language', 'Taal') }}
              <select
                [value]="appState.language()"
                (change)="appState.language.set($any($event.target).value)"
              >
                <option value="en">English</option>
                <option value="nl">Nederlands</option>
              </select>
            </label>
            <label class="setting-field">
              {{ t('Parallel video syncs', 'Gelijktijdige video-synchronisaties') }}
              <input
                type="number"
                min="1"
                max="8"
                [value]="appState.maxParallelDownloads()"
                (input)="appState.maxParallelDownloads.set(+$any($event.target).value)"
              />
            </label>
            <label class="setting-field">
              {{ t('Browser for YouTube sign-in', 'Browser voor YouTube-login') }}
              <select
                [value]="appState.cookiesBrowser()"
                (change)="appState.cookiesBrowser.set($any($event.target).value)"
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
            @if (settingsError()) {
              <p class="error">{{ settingsError() }}</p>
            }
          </section>
        } @else if (appState.settingsLoaded()) {
          <router-outlet />
        }

        @if (appState.error()) {
          <p class="error" role="alert">{{ appState.error() }}</p>
        }
      </main>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-height: 100vh;
        color-scheme: dark;
        background:
          radial-gradient(ellipse at 83% -15%, rgba(86, 43, 159, 0.28), transparent 44%),
          radial-gradient(ellipse at 0% 80%, rgba(10, 102, 145, 0.13), transparent 40%),
          var(--bg);
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
        display: grid;
        grid-template-columns: 254px minmax(0, 1fr);
        min-height: 100vh;
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
      .sidebar::after {
        content: '●  LOCAL ARCHIVE  /  READY';
        margin: auto 6px 0;
        padding: 15px 9px 0;
        border-top: 1px solid var(--line);
        color: #71819f;
        font: 9px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: 0.09em;
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
      .nav-item {
        position: relative;
        display: flex;
        align-items: center;
        gap: 13px;
        margin: 4px 0;
        padding: 12px 13px;
        border: 1px solid transparent;
        border-radius: 9px;
        color: #97a7c2;
        font-size: 13px;
        letter-spacing: 0.025em;
        text-decoration: none;
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
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        min-height: 52px;
        margin-bottom: 27px;
      }
      h1 {
        margin: 0;
        margin-right: auto;
        color: #f4f8ff;
        font-size: clamp(23px, 2.4vw, 31px);
        font-weight: 650;
        letter-spacing: -0.045em;
      }
      h1::before {
        content: 'COLLECTION / ';
        display: block;
        margin-bottom: 6px;
        color: #7587a6;
        font: 9px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: 0.19em;
      }
      .dir {
        max-width: min(37vw, 460px);
        margin: 13px 12px 0 auto;
        color: #74849f;
        font: 10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
        word-break: break-all;
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
        transform: none;
        filter: none;
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
        margin: 0;
        font-size: 21px;
        letter-spacing: -0.025em;
      }
      .setup p {
        color: #8d9db7;
      }
      .setting-field {
        display: flex;
        align-items: center;
        gap: 16px;
        max-width: 520px;
        margin-top: 16px;
        cursor: default;
        color: #bdcbe0;
        font-size: 13px;
      }
      .setting-field input {
        width: 88px;
        padding: 8px;
        border: 1px solid rgba(139, 164, 209, 0.24);
        border-radius: 8px;
        background: #0a1121;
        color: var(--ink);
      }
      .setting-field select {
        padding: 8px;
        border: 1px solid rgba(139, 164, 209, 0.24);
        border-radius: 8px;
        background: #0a1121;
        color: var(--ink);
      }
      .setting-hint {
        margin-top: 6px;
        font-size: 13px;
        color: #7889a5 !important;
      }
      @media (max-width: 800px) {
        .layout { grid-template-columns: 205px minmax(0, 1fr); }
        main { padding-inline: 22px; }
      }
      @media (max-width: 600px) {
        .layout { grid-template-columns: 62px minmax(0, 1fr); }
        .sidebar { padding: 20px 5px; }
        .brand { padding: 0 0 35px; }
        .brand::before { left: 12px; }
        .sidebar::after { writing-mode: vertical-rl; align-self: center; padding: 12px 0 0; font-size: 7px; }
        .nav-item { min-height: 41px; justify-content: center; }
        .nav-item span { display: none; }
        .nav-item.active::after { display: none; }
        main { padding: 20px 13px 48px; }
        header { gap: 8px; margin-bottom: 18px; }
        h1 { font-size: 22px; }
        .dir { order: 3; flex: 1 0 100%; max-width: 100%; margin: -5px 0 0; }
        .setting-field { align-items: flex-start; flex-direction: column; gap: 6px; }
        .setting-field select { max-width: 100%; }
      }
    `,
  ],
})
export class AppComponent {
  appState = inject(AppStateService);
  private settingsApi = inject(SettingsApiService);
  private router = inject(Router);

  settingsOpen = signal(false);
  folderPath = signal('');
  saving = signal(false);
  settingsError = signal('');

  private navEnd = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      takeUntilDestroyed(),
    ),
  );

  pageTitle = computed(() => {
    const url = this.navEnd()?.urlAfterRedirects ?? this.router.url;
    if (url.startsWith('/channels')) return this.t('My Channels', 'Mijn kanalen');
    if (url.startsWith('/suggestions')) return this.t('Suggestions', 'Suggesties');
    if (url.startsWith('/sync')) return this.t('Sync progress', 'Syncvoortgang');
    if (url.startsWith('/channel')) {
      const channelUrl = new URLSearchParams(url.split('?')[1] ?? '').get('url');
      const channel = this.appState.channels().find((c) => c.url === channelUrl);
      return channel?.title ?? this.t('Channel', 'Kanaal');
    }
    return this.t('Overview', 'Overzicht');
  });

  constructor() {
    effect(() => {
      const dir = this.appState.state().dir;
      if (dir && !this.folderPath()) this.folderPath.set(dir);
    });
  }

  t(english: string, dutch: string) {
    return this.appState.t(english, dutch);
  }

  saveSettings() {
    this.saving.set(true);
    this.settingsError.set('');
    this.settingsApi
      .saveSettings({
        downloadDir: this.folderPath().trim(),
        maxParallelDownloads: this.appState.maxParallelDownloads(),
        cookiesBrowser: this.appState.cookiesBrowser(),
        language: this.appState.language(),
      })
      .subscribe({
        next: (settings) => {
          this.appState.applySettings(settings);
          this.settingsOpen.set(false);
          this.saving.set(false);
        },
        error: (e) => {
          this.settingsError.set(
            e.error?.message ??
              this.t('Could not save settings.', 'Instellingen opslaan is mislukt.'),
          );
          this.saving.set(false);
        },
      });
  }
}

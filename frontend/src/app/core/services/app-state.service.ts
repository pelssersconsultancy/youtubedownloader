import { Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, catchError, interval, startWith, switchMap } from 'rxjs';
import type { State } from '../models/video.model';
import type { Channel } from '../models/channel.model';
import type { Settings } from '../models/settings.model';
import { SyncApiService } from './sync-api.service';
import { SettingsApiService } from './settings-api.service';
import { ChannelApiService } from './channel-api.service';

@Injectable({ providedIn: 'root' })
export class AppStateService {
  private syncApi = inject(SyncApiService);
  private settingsApi = inject(SettingsApiService);
  private channelApi = inject(ChannelApiService);

  language = signal<'en' | 'nl'>('en');
  settingsLoaded = signal(false);
  storageLocationFixed = signal(false);
  channels = signal<Channel[]>([]);
  error = signal('');

  maxParallelDownloads = signal(1);
  cookiesBrowser = signal('chrome');

  state = signal<State>({
    dir: '',
    downloaded: [],
    queued: [],
    current: null,
    syncEnabled: true,
    failed: [],
  });

  constructor() {
    this.settingsApi.getSettings().subscribe({
      next: (settings) => this.applySettings(settings),
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

    interval(2000)
      .pipe(
        startWith(0),
        switchMap(() => this.syncApi.getState().pipe(catchError(() => EMPTY))),
        takeUntilDestroyed(),
      )
      .subscribe((s) => this.state.set(s));
  }

  applySettings(settings: Settings) {
    this.storageLocationFixed.set(settings.downloadDirFixed === true);
    this.state.update((s) => ({
      ...s,
      dir: settings.downloadDir ?? '',
      syncEnabled: settings.syncEnabled ?? true,
    }));
    this.maxParallelDownloads.set(settings.maxParallelDownloads ?? 1);
    this.cookiesBrowser.set(settings.cookiesBrowser ?? 'chrome');
    this.language.set(settings.language === 'nl' ? 'nl' : 'en');
    this.settingsLoaded.set(true);
    if (settings.downloadDir) this.loadChannels();
  }

  loadChannels() {
    this.channelApi.getChannels().subscribe({
      next: (channels) => this.channels.set(channels),
    });
  }

  t(english: string, dutch: string): string {
    return this.language() === 'nl' ? dutch : english;
  }
}

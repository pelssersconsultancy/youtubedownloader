import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { Settings } from '../models/settings.model';

const API = '/api';

@Injectable({ providedIn: 'root' })
export class SettingsApiService {
  private http = inject(HttpClient);

  getSettings() {
    return this.http.get<Settings>(`${API}/settings`);
  }

  saveSettings(payload: {
    downloadDir: string;
    maxParallelDownloads: number;
    cookiesBrowser: string;
    language: 'en' | 'nl';
  }) {
    return this.http.post<Settings>(`${API}/settings`, payload);
  }
}

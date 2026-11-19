import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { State } from '../models/video.model';

const API = '/api';

@Injectable({ providedIn: 'root' })
export class SyncApiService {
  private http = inject(HttpClient);

  getState() {
    return this.http.get<State>(`${API}/state`);
  }

  toggleSync(enabled: boolean) {
    return this.http.patch<{ enabled: boolean; state: State }>(`${API}/sync`, { enabled });
  }

  getFailureLog(lines = 1000) {
    return this.http.get<{ lines: string[] }>(`${API}/sync/failures`, { params: { lines } });
  }
}

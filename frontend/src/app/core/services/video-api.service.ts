import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { VideoPage, State } from '../models/video.model';

const API = '/api';

@Injectable({ providedIn: 'root' })
export class VideoApiService {
  private http = inject(HttpClient);

  getVideos(query: string, offset: number, limit: number) {
    return this.http.get<VideoPage>(`${API}/videos`, { params: { q: query, offset, limit } });
  }

  download(ids: string[]) {
    return this.http.post<State>(`${API}/download`, { ids });
  }

  videoStreamUrl(id: string) {
    return `${API}/videos/${id}/play`;
  }

  subtitleUrl(id: string, language: 'en' | 'nl') {
    return `${API}/videos/${id}/subtitles/${language}`;
  }
}

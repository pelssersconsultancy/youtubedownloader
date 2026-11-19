import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { Channel, SuggestionSection, ChannelSyncProgress } from '../models/channel.model';
import type { VideoPage } from '../models/video.model';

const API = '/api';

@Injectable({ providedIn: 'root' })
export class ChannelApiService {
  private http = inject(HttpClient);

  getChannels() {
    return this.http.get<Channel[]>(`${API}/channels`);
  }

  addChannel(url: string) {
    return this.http.post<{ channels: Channel[] }>(`${API}/channels`, { url });
  }

  removeChannel(url: string) {
    return this.http.delete<Channel[]>(`${API}/channels`, { params: { url } });
  }

  reorderChannels(urls: string[]) {
    return this.http.patch<Channel[]>(`${API}/channels/order`, { urls });
  }

  setAutoSync(url: string, enabled: boolean) {
    return this.http.patch<{ channels: Channel[]; scanned: number; queued: number }>(
      `${API}/channels/autosync`,
      { url, enabled },
    );
  }

  getChannelVideos(url: string, offset: number, limit: number) {
    return this.http.get<VideoPage>(`${API}/channels/videos`, { params: { url, offset, limit } });
  }

  getProgress() {
    return this.http.get<ChannelSyncProgress[]>(`${API}/channels/progress`);
  }

  getSuggestions() {
    return this.http.get<SuggestionSection[]>(`${API}/suggestions`);
  }
}

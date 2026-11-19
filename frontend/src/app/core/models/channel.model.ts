import type { Video, SyncVideo } from './video.model';

export interface Channel {
  url: string;
  title: string;
  addedAt: string;
  autoSync: boolean;
}

export interface Suggestion {
  title: string;
  url: string;
  verified: boolean;
}

export interface SuggestionSubsection {
  title: string;
  channels: Suggestion[];
}

export interface SuggestionSection {
  title: string;
  subsections: SuggestionSubsection[];
}

export interface ChannelSyncProgress extends Channel {
  total: number;
  completed: number;
  active: SyncVideo[];
  queued: Video[];
  failed: Video[];
  percent: number;
  scanning: boolean;
}

export interface Video {
  id: string;
  title: string;
  thumbnail: string;
  duration: number | null;
  keywords: string[];
}

export interface VideoPage {
  items: Video[];
  total: number;
  offset: number;
  hasMore: boolean;
  scanning?: boolean;
}

export interface SyncVideo {
  id: string;
  title: string;
  thumbnail: string;
  progress: number;
}

export interface RetryJob {
  id: string;
  attempt: number;
  nextAttemptAt: number | null;
  errorClass: string | null;
}

export interface State {
  dir: string;
  downloaded: string[];
  queued: string[];
  current: SyncVideo | null;
  active?: SyncVideo[];
  queuedItems?: SyncVideo[];
  syncEnabled: boolean;
  retryAt?: number | null;
  failed: string[];
  retrying?: RetryJob[];
  subtitleRetrying?: RetryJob[];
}

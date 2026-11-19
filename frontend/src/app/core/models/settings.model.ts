export interface Settings {
  downloadDir: string | null;
  downloadDirFixed?: boolean;
  maxParallelDownloads: number;
  cookiesBrowser: string;
  syncEnabled: boolean;
  language: 'en' | 'nl';
}

import type { IStorageLayer } from './storage/IStorageLayer.js';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

export const GOOGLE_DRIVE_SCOPES = [DRIVE_FILE_SCOPE, DRIVE_APPDATA_SCOPE] as const;

export interface GoogleHttpClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface GoogleDriverOptions {
  getAccessToken: () => string | null;
  httpClient?: GoogleHttpClient;
  storageLayer?: IStorageLayer;
}

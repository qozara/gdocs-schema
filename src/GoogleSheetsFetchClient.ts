export interface GoogleSheetsFetchClientOptions {
  accessToken: string;
  fetchImpl?: typeof fetch;
}

export class GoogleSheetsFetchClient {
  private accessToken: string;
  private fetch: typeof fetch;

  constructor(options: GoogleSheetsFetchClientOptions) {
    this.accessToken = options.accessToken;
    this.fetch = options.fetchImpl || globalThis.fetch;
  }

  private async request(url: string, init: RequestInit = {}): Promise<any> {
    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      ...init.headers,
    };

    const response = await this.fetch(url, {
      ...init,
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Google API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    return response.json();
  }

  async getSpreadsheet(spreadsheetId: string): Promise<any> {
    return this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`
    );
  }

  async batchGet(spreadsheetId: string, ranges: string[]): Promise<any> {
    const encodedRanges = ranges.map(encodeURIComponent).join('&ranges=');
    return this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet?ranges=${encodedRanges}`
    );
  }

  async batchUpdate(spreadsheetId: string, requests: any[]): Promise<any> {
    return this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({ requests }),
      }
    );
  }

  async acquireLock(
    spreadsheetId: string,
    clientUuid: string,
    ttlMs: number = 3 * 60 * 1000 // default 3 minutes TTL
  ): Promise<boolean> {
    // 1. Fetch current etag and appProperties from Drive API
    const fileUrl = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=etag,appProperties`;
    const metadata = await this.request(fileUrl);

    const appProperties = metadata.appProperties || {};
    const existingLockStr = appProperties.migration_lock;

    if (existingLockStr) {
      try {
        const existingLock = JSON.parse(existingLockStr);
        const now = Date.now();
        if (
          existingLock.acquiredAt &&
          now - existingLock.acquiredAt < ttlMs &&
          existingLock.owner !== clientUuid
        ) {
          throw new Error('Lock already acquired by another client');
        }
      } catch (err: any) {
        if (err.message === 'Lock already acquired by another client') {
          throw err;
        }
        // If JSON parsing fails, we assume the lock metadata is invalid and overwrite it
      }
    }

    // 2. Try to update appProperties setting the lock
    const newLock = {
      owner: clientUuid,
      acquiredAt: Date.now(),
    };

    try {
      await this.request(fileUrl, {
        method: 'PATCH',
        headers: {
          'If-Match': metadata.etag,
        },
        body: JSON.stringify({
          appProperties: {
            migration_lock: JSON.stringify(newLock),
          },
        }),
      });
      return true;
    } catch (err: any) {
      // If 412 is thrown, it's a conflict
      if (err.message.includes('412')) {
        throw new Error('Lock acquisition failed due to concurrency conflict');
      }
      throw err;
    }
  }

  async releaseLock(spreadsheetId: string, clientUuid: string): Promise<boolean> {
    const fileUrl = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=etag,appProperties`;
    const metadata = await this.request(fileUrl);

    const appProperties = metadata.appProperties || {};
    const existingLockStr = appProperties.migration_lock;

    if (!existingLockStr) {
      return true;
    }

    try {
      const existingLock = JSON.parse(existingLockStr);
      if (existingLock.owner !== clientUuid) {
        throw new Error('Lock is owned by a different client');
      }
    } catch {
      // If invalid JSON, we still allow clearing it
    }

    await this.request(fileUrl, {
      method: 'PATCH',
      headers: {
        'If-Match': metadata.etag,
      },
      body: JSON.stringify({
        appProperties: {
          migration_lock: null,
        },
      }),
    });

    return true;
  }

  async createBackup(spreadsheetId: string): Promise<string> {
    const copyUrl = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/copy`;
    const result = await this.request(copyUrl, {
      method: 'POST',
      body: JSON.stringify({
        name: `Backup of ${spreadsheetId} - ${new Date().toISOString()}`,
      }),
    });
    return result.id;
  }

  async restoreBackup(backupId: string, spreadsheetId: string): Promise<void> {
    // 1. Get sheets from target spreadsheet to find original sheet IDs
    const targetMeta = await this.getSpreadsheet(spreadsheetId);
    const originalSheets = targetMeta.sheets || [];

    // 2. Get sheets from backup spreadsheet
    const backupMeta = await this.getSpreadsheet(backupId);
    const backupSheets = backupMeta.sheets || [];

    // 3. Copy each backup sheet to the target spreadsheet
    const copiedSheets: { newSheetId: number; originalTitle: string }[] = [];
    for (const sheet of backupSheets) {
      const copyUrl = `https://sheets.googleapis.com/v4/spreadsheets/${backupId}/sheets/${sheet.properties.sheetId}:copyTo`;
      const copyResult = await this.request(copyUrl, {
        method: 'POST',
        body: JSON.stringify({ destinationSpreadsheetId: spreadsheetId }),
      });
      copiedSheets.push({
        newSheetId: copyResult.sheetId,
        originalTitle: sheet.properties.title,
      });
    }

    // 4. Perform a batch update to delete original sheets and rename copied sheets
    const requests: any[] = [];
    for (const sheet of originalSheets) {
      requests.push({
        deleteSheet: { sheetId: sheet.properties.sheetId },
      });
    }
    for (const copied of copiedSheets) {
      requests.push({
        updateSheetProperties: {
          properties: {
            sheetId: copied.newSheetId,
            title: copied.originalTitle,
          },
          fields: 'title',
        },
      });
    }

    await this.batchUpdate(spreadsheetId, requests);
  }
}

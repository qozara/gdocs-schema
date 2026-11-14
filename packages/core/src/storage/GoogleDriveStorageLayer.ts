import type { IStorageLayer } from './IStorageLayer.js';

const DRIVE_API_URL = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3';
const SHEETS_API_URL = 'https://sheets.googleapis.com/v4/spreadsheets';

export class GoogleDriveStorageLayer implements IStorageLayer {
  constructor(private getToken: () => string | null) {}

  private async fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
    const token = this.getToken();
    if (!token) throw new Error('No access token found. Please sign in.');

    const hasBody =
      options.body !== undefined || (Boolean(options.method) && options.method !== 'GET');
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers as Record<string, string> | undefined),
    };

    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
      if (response.status === 401) {
        const error: any = new Error('Session expired (401). Please reload to sign in again.');
        error.status = 401;
        throw error;
      }
      const errorBody = await response.text();
      throw new Error(`Google API Error ${response.status}: ${errorBody}`);
    }
    return response;
  }

  async listFiles(
    query: string,
    fields = 'files(id, name, createdTime, owners, capabilities, properties)'
  ): Promise<any[]> {
    const res = await this.fetchWithAuth(
      `${DRIVE_API_URL}/files?q=${encodeURIComponent(query)}&fields=${encodeURIComponent(fields)}`
    );
    const data = (await res.json()) as any;
    return data.files || [];
  }

  async getFile(fileId: string, options?: { alt?: string; fields?: string }): Promise<any> {
    let url = `${DRIVE_API_URL}/files/${fileId}?`;
    if (options?.alt) url += `alt=${options.alt}&`;
    if (options?.fields) url += `fields=${encodeURIComponent(options.fields)}&`;

    const res = await this.fetchWithAuth(url);
    return await res.json();
  }

  async createFile(
    name: string,
    mimeType: string,
    properties?: Record<string, string>,
    content?: string
  ): Promise<string> {
    const metadata = { name, mimeType, properties };
    const res = await this.fetchWithAuth(`${DRIVE_API_URL}/files`, {
      method: 'POST',
      body: JSON.stringify(metadata),
    });
    const data = (await res.json()) as any;

    if (content) {
      await this.fetchWithAuth(`${DRIVE_UPLOAD_URL}/files/${data.id}?uploadType=media`, {
        method: 'PATCH',
        body: content,
      });
    }
    return data.id;
  }

  async updateFile(fileId: string, metadata?: any, content?: string): Promise<any> {
    if (content) {
      await this.fetchWithAuth(`${DRIVE_UPLOAD_URL}/files/${fileId}?uploadType=media`, {
        method: 'PATCH',
        body: content,
      });
    }
    if (metadata && Object.keys(metadata).length > 0) {
      const res = await this.fetchWithAuth(`${DRIVE_API_URL}/files/${fileId}`, {
        method: 'PATCH',
        body: JSON.stringify(metadata),
      });
      return await res.json();
    }
  }

  async deleteFile(fileId: string): Promise<void> {
    try {
      await this.fetchWithAuth(`${DRIVE_API_URL}/files/${fileId}`, { method: 'DELETE' });
    } catch (e: any) {
      if (e.message && e.message.includes('404')) {
        return;
      }
      throw e;
    }
  }

  async createPermission(
    fileId: string,
    role: string,
    type: string,
    emailAddress?: string
  ): Promise<any> {
    const res = await this.fetchWithAuth(`${DRIVE_API_URL}/files/${fileId}/permissions`, {
      method: 'POST',
      body: JSON.stringify({ role, type, emailAddress }),
    });
    return await res.json();
  }

  async listPermissions(fileId: string): Promise<any[]> {
    const res = await this.fetchWithAuth(
      `${DRIVE_API_URL}/files/${fileId}/permissions?fields=permissions(id,type,role,emailAddress,displayName,photoLink,deleted)`
    );
    const data = (await res.json()) as any;
    return data.permissions || [];
  }

  async deletePermission(fileId: string, permissionId: string): Promise<void> {
    await this.fetchWithAuth(`${DRIVE_API_URL}/files/${fileId}/permissions/${permissionId}`, {
      method: 'DELETE',
    });
  }

  async createSpreadsheet(
    title: string,
    sheetTitles: string[],
    properties?: Record<string, string>
  ): Promise<string> {
    const res = await this.fetchWithAuth(SHEETS_API_URL, {
      method: 'POST',
      body: JSON.stringify({
        properties: { title },
        sheets: sheetTitles.map((t) => ({
          properties: { title: t, gridProperties: { frozenRowCount: 1 } },
        })),
      }),
    });
    const data = (await res.json()) as any;
    if (properties) {
      await this.updateFile(data.spreadsheetId, { properties });
    }
    return data.spreadsheetId;
  }

  async getSpreadsheet(spreadsheetId: string, fields?: string): Promise<any> {
    const url = fields
      ? `${SHEETS_API_URL}/${spreadsheetId}?fields=${encodeURIComponent(fields)}`
      : `${SHEETS_API_URL}/${spreadsheetId}`;
    const res = await this.fetchWithAuth(url);
    return await res.json();
  }

  async batchGetValues(spreadsheetId: string, ranges: string[]): Promise<any[]> {
    const rangesQuery = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
    const res = await this.fetchWithAuth(
      `${SHEETS_API_URL}/${spreadsheetId}/values:batchGet?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&${rangesQuery}`
    );
    const data = (await res.json()) as any;
    return data.valueRanges || [];
  }

  async batchUpdateValues(
    spreadsheetId: string,
    data: { range: string; values: any[][] }[]
  ): Promise<void> {
    await this.fetchWithAuth(`${SHEETS_API_URL}/${spreadsheetId}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'USER_ENTERED',
        data,
      }),
    });
  }

  async appendValues(spreadsheetId: string, range: string, values: any[][]): Promise<void> {
    await this.fetchWithAuth(
      `${SHEETS_API_URL}/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`,
      {
        method: 'POST',
        body: JSON.stringify({ values }),
      }
    );
  }

  async updateValues(spreadsheetId: string, range: string, values: any[][]): Promise<void> {
    await this.fetchWithAuth(
      `${SHEETS_API_URL}/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        body: JSON.stringify({ values }),
      }
    );
  }

  async batchUpdateSpreadsheet(spreadsheetId: string, requests: any[]): Promise<void> {
    await this.fetchWithAuth(`${SHEETS_API_URL}/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests }),
    });
  }

  async getLastModified(fileId: string): Promise<string> {
    const meta = await this.getFile(fileId, { fields: 'modifiedTime,trashed' });
    if (meta?.trashed) {
      const err: any = new Error(`File ${fileId} is trashed`);
      err.name = 'GroupFileUnavailableError';
      err.trashed = true;
      throw err;
    }
    return meta?.modifiedTime || '';
  }
}

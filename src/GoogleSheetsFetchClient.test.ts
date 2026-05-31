import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleSheetsFetchClient } from './GoogleSheetsFetchClient.js';

describe('GoogleSheetsFetchClient', () => {
  let mockFetch: any;
  let client: GoogleSheetsFetchClient;
  const spreadsheetId = 'test-spreadsheet-id';
  const accessToken = 'test-token';

  beforeEach(() => {
    mockFetch = vi.fn();
    client = new GoogleSheetsFetchClient({
      accessToken,
      fetchImpl: mockFetch,
    });
  });

  describe('getSpreadsheet', () => {
    it('should fetch spreadsheet metadata correctly', async () => {
      const mockResponse = {
        spreadsheetId,
        properties: { title: 'Test Spreadsheet' },
        sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await client.getSpreadsheet(spreadsheetId);

      expect(mockFetch).toHaveBeenCalledWith(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );
      expect(result).toEqual(mockResponse);
    });

    it('should throw error when fetch fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        statusText: 'Unauthorized',
        status: 401,
        text: async () => 'Invalid credentials',
      });

      await expect(client.getSpreadsheet(spreadsheetId)).rejects.toThrow(
        'Google API error: 401 Unauthorized - Invalid credentials'
      );
    });
  });

  describe('batchGet', () => {
    it('should call batchGet endpoint with correct ranges', async () => {
      const mockResponse = {
        spreadsheetId,
        valueRanges: [{ range: 'Sheet1!A1:B2', values: [['x', 'y']] }],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const ranges = ['Sheet1!A1:B2'];
      const result = await client.batchGet(spreadsheetId, ranges);

      expect(mockFetch).toHaveBeenCalledWith(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet?ranges=Sheet1!A1%3AB2`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('batchUpdate', () => {
    it('should send batchUpdate request body correctly', async () => {
      const mockResponse = {
        spreadsheetId,
        replies: [{}],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const requests = [{ addSheet: { properties: { title: 'NewSheet' } } }];
      const result = await client.batchUpdate(spreadsheetId, requests);

      expect(mockFetch).toHaveBeenCalledWith(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ requests }),
        }
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('lock mechanism', () => {
    it('should acquire lock when no lock exists', async () => {
      // Mock GET metadata: no lock properties
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          etag: 'etag-123',
          appProperties: {},
        }),
      });

      // Mock PATCH metadata: success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          etag: 'etag-456',
          appProperties: {
            migration_lock: JSON.stringify({ owner: 'client-1', acquiredAt: Date.now() }),
          },
        }),
      });

      const success = await client.acquireLock(spreadsheetId, 'client-1');
      expect(success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should fail to acquire lock if lock exists and not expired', async () => {
      // Mock GET metadata: active lock
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          etag: 'etag-123',
          appProperties: {
            migration_lock: JSON.stringify({ owner: 'client-2', acquiredAt: Date.now() }),
          },
        }),
      });

      await expect(client.acquireLock(spreadsheetId, 'client-1')).rejects.toThrow(
        'Lock already acquired by another client'
      );
    });

    it('should acquire lock if lock exists but is expired', async () => {
      // Mock GET metadata: expired lock (5 mins ago, TTL defaults to 3 mins)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          etag: 'etag-123',
          appProperties: {
            migration_lock: JSON.stringify({ owner: 'client-2', acquiredAt: Date.now() - 5 * 60 * 1000 }),
          },
        }),
      });

      // Mock PATCH metadata: success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ etag: 'etag-456' }),
      });

      const success = await client.acquireLock(spreadsheetId, 'client-1');
      expect(success).toBe(true);
    });

    it('should release lock if owned by client', async () => {
      // Mock GET metadata: lock owned by client-1
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          etag: 'etag-123',
          appProperties: {
            migration_lock: JSON.stringify({ owner: 'client-1', acquiredAt: Date.now() }),
          },
        }),
      });

      // Mock PATCH metadata to clear lock
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ etag: 'etag-456' }),
      });

      const success = await client.releaseLock(spreadsheetId, 'client-1');
      expect(success).toBe(true);

      const patchCall = mockFetch.mock.calls[1];
      expect(patchCall[0]).toBe(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=etag,appProperties`);
      expect(patchCall[1].method).toBe('PATCH');
      expect(JSON.parse(patchCall[1].body).appProperties.migration_lock).toBeNull();
    });
  });

  describe('backup and restore', () => {
    it('should create backup using Drive copy API', async () => {
      const mockResponse = { id: 'backup-id-123' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await client.createBackup(spreadsheetId);
      expect(result).toBe('backup-id-123');
      expect(mockFetch).toHaveBeenCalledWith(
        `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/copy`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: expect.any(String),
        }
      );
    });

    it('should restore backup by copying sheets and replacing old ones', async () => {
      const backupId = 'backup-id-123';

      // 1. Get original sheets
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sheets: [{ properties: { sheetId: 10, title: 'Sheet1' } }],
        }),
      });

      // 2. Get backup sheets
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sheets: [{ properties: { sheetId: 20, title: 'Sheet1' } }],
        }),
      });

      // 3. Copy sheet to original
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sheetId: 30,
          title: 'Copy of Sheet1',
        }),
      });

      // 4. Batch update to delete and rename
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await client.restoreBackup(backupId, spreadsheetId);

      // Verify copy call
      expect(mockFetch).toHaveBeenCalledWith(
        `https://sheets.googleapis.com/v4/spreadsheets/${backupId}/sheets/20:copyTo`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ destinationSpreadsheetId: spreadsheetId }),
        })
      );

      // Verify batchUpdate call
      expect(mockFetch).toHaveBeenCalledWith(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            requests: [
              { deleteSheet: { sheetId: 10 } },
              {
                updateSheetProperties: {
                  properties: { sheetId: 30, title: 'Sheet1' },
                  fields: 'title',
                },
              },
            ],
          }),
        })
      );
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MigrationManager } from './MigrationManager.js';
import { GoogleSheetsFetchClient } from './GoogleSheetsFetchClient.js';
import { Migration } from './types.js';

describe('MigrationManager', () => {
  let mockClient: any;
  let manager: MigrationManager;
  const spreadsheetId = 'test-spreadsheet-id';

  beforeEach(() => {
    mockClient = {
      acquireLock: vi.fn(),
      releaseLock: vi.fn(),
      getSpreadsheet: vi.fn(),
      batchGet: vi.fn(),
      batchUpdate: vi.fn(),
      createBackup: vi.fn(),
      restoreBackup: vi.fn(),
      deleteFile: vi.fn(), // optional backup cleanup method
    };
    manager = new MigrationManager(mockClient as unknown as GoogleSheetsFetchClient);
  });

  it('should run pending migrations successfully', async () => {
    // 1. Lock acquisition succeeds
    mockClient.acquireLock.mockResolvedValueOnce(true);

    // 2. Spreadsheet exists with _migrations tab
    mockClient.getSpreadsheet.mockResolvedValueOnce({
      sheets: [
        { properties: { sheetId: 12345, title: '_migrations' } },
      ],
    });

    // 3. Current migration version is 1
    mockClient.batchGet.mockResolvedValueOnce({
      valueRanges: [
        {
          range: '_migrations!A:B',
          values: [
            ['version', 'migrated_at'],
            ['1', '2026-05-30T00:00:00.000Z'],
          ],
        },
      ],
    });

    // 4. Backup is created successfully
    mockClient.createBackup.mockResolvedValueOnce('backup-id');

    // 5. Setup migrations: version 1 (already applied), version 2 (pending)
    const m1Up = vi.fn().mockResolvedValue(null);
    const m1Down = vi.fn().mockResolvedValue(null);
    const m2Up = vi.fn().mockResolvedValue(null);
    const m2Down = vi.fn().mockResolvedValue(null);

    const migrations: Migration[] = [
      { version: 1, up: m1Up, down: m1Down },
      { version: 2, up: m2Up, down: m2Down },
    ];

    const result = await manager.runMigrations(spreadsheetId, migrations);

    expect(result.success).toBe(true);
    expect(result.applied).toEqual([2]);

    expect(m1Up).not.toHaveBeenCalled();
    expect(m2Up).toHaveBeenCalledWith(mockClient, spreadsheetId);

    // Verify lock flow
    expect(mockClient.acquireLock).toHaveBeenCalled();
    expect(mockClient.releaseLock).toHaveBeenCalled();

    // Verify version update appendCells call
    expect(mockClient.batchUpdate).toHaveBeenCalledWith(
      spreadsheetId,
      expect.arrayContaining([
        expect.objectContaining({
          appendCells: expect.objectContaining({
            sheetId: 12345,
            rows: expect.arrayContaining([
              expect.objectContaining({
                values: expect.arrayContaining([
                  expect.objectContaining({ userEnteredValue: { numberValue: 2 } }),
                ]),
              }),
            ]),
          }),
        }),
      ])
    );
  });

  it('should initialize _migrations tab if it does not exist', async () => {
    mockClient.acquireLock.mockResolvedValueOnce(true);

    // 1. Spreadsheet exists but does NOT have _migrations tab
    mockClient.getSpreadsheet.mockResolvedValueOnce({
      sheets: [
        { properties: { sheetId: 1, title: 'Users' } },
      ],
    });

    // 2. Mock batchUpdate for creating sheet (returns sheetId 999)
    mockClient.batchUpdate.mockResolvedValueOnce({
      replies: [{ addSheet: { properties: { sheetId: 999, title: '_migrations' } } }],
    });

    // 3. Backup created
    mockClient.createBackup.mockResolvedValueOnce('backup-id');

    const m1Up = vi.fn().mockResolvedValue(null);
    const migrations: Migration[] = [
      { version: 1, up: m1Up, down: vi.fn() },
    ];

    const result = await manager.runMigrations(spreadsheetId, migrations);

    expect(result.success).toBe(true);
    expect(result.applied).toEqual([1]);
    expect(m1Up).toHaveBeenCalled();

    // Verify initialization of _migrations was called
    expect(mockClient.batchUpdate).toHaveBeenCalledWith(
      spreadsheetId,
      expect.arrayContaining([
        expect.objectContaining({
          addSheet: expect.objectContaining({
            properties: expect.objectContaining({ title: '_migrations', hidden: true }),
          }),
        }),
      ])
    );
  });

  it('should restore backup and throw if migration fails', async () => {
    mockClient.acquireLock.mockResolvedValueOnce(true);
    mockClient.getSpreadsheet.mockResolvedValueOnce({
      sheets: [{ properties: { sheetId: 12345, title: '_migrations' } }],
    });
    mockClient.batchGet.mockResolvedValueOnce({
      valueRanges: [{ range: '_migrations!A:B', values: [['version', 'migrated_at'], ['0', '']] }],
    });
    mockClient.createBackup.mockResolvedValueOnce('backup-id-123');

    // Migration that fails
    const badUp = vi.fn().mockRejectedValue(new Error('Migration failed'));
    const migrations: Migration[] = [
      { version: 1, up: badUp, down: vi.fn() },
    ];

    await expect(manager.runMigrations(spreadsheetId, migrations)).rejects.toThrow('Migration failed');

    // Verify rollback
    expect(mockClient.restoreBackup).toHaveBeenCalledWith('backup-id-123', spreadsheetId);
    expect(mockClient.releaseLock).toHaveBeenCalled();
  });
});

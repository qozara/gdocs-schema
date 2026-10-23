import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchemaEngine } from './SchemaEngine.js';
import { GoogleSheetsFetchClient } from './GoogleSheetsFetchClient.js';
import { SchemaDefinition, ValidationStatus, Migration } from './types.js';

describe('SchemaEngine', () => {
  let mockClient: any;
  let engine: SchemaEngine;
  const spreadsheetId = 'sheet-123';

  const schema: SchemaDefinition = {
    version: 2,
    tabs: [
      {
        name: 'Users',
        columns: [
          { name: 'id', type: 'string', required: true },
          { name: 'name', type: 'string' },
          { name: 'email', type: 'string', required: true },
        ],
      },
      {
        name: 'Settings',
        columns: [
          { name: 'key', type: 'string', required: true },
          { name: 'value', type: 'string', required: true },
        ],
      },
    ],
  };

  beforeEach(() => {
    mockClient = {
      getSpreadsheetMetadata: vi.fn(),
      batchGet: vi.fn(),
      batchUpdate: vi.fn(),
      createBackup: vi.fn().mockResolvedValue('backup-123'),
      restoreBackup: vi.fn().mockResolvedValue(undefined),
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(true),
    };
    engine = new SchemaEngine(mockClient as unknown as GoogleSheetsFetchClient);
  });

  describe('checkHealth', () => {
    it('1. Legacy spreadsheet with no _migrations tab -> returns UPGRADE_REQUIRED (v1) in 1 API call', async () => {
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        properties: { title: 'Legacy Sheet' },
        sheets: [
          { properties: { sheetId: 1, title: 'Users' } },
        ],
      });

      const result = await engine.checkHealth(spreadsheetId, schema);

      expect(result).toEqual({
        spreadsheetId,
        currentVersion: 1,
        latestVersion: 2,
        status: ValidationStatus.UPGRADE_REQUIRED,
        missingTabs: [],
        missingColumns: {},
        canAutoMigrate: true,
      });

      expect(mockClient.getSpreadsheetMetadata).toHaveBeenCalledTimes(1);
      expect(mockClient.batchGet).not.toHaveBeenCalled();
    });

    it('returns UPGRADE_REQUIRED with version 0 if spreadsheet is completely empty with no sheets', async () => {
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        properties: { title: 'Empty Sheet' },
        sheets: [],
      });

      const result = await engine.checkHealth(spreadsheetId, schema);

      expect(result).toEqual({
        spreadsheetId,
        currentVersion: 0,
        latestVersion: 2,
        status: ValidationStatus.UPGRADE_REQUIRED,
        missingTabs: [],
        missingColumns: {},
        canAutoMigrate: true,
      });

      expect(mockClient.batchGet).not.toHaveBeenCalled();
    });

    it('2. Spreadsheet with _migrations containing version 1 -> returns UPGRADE_REQUIRED', async () => {
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        properties: { title: 'V1 Sheet' },
        sheets: [
          { properties: { sheetId: 999, title: '_migrations' } },
          { properties: { sheetId: 1, title: 'Users' } },
        ],
      });

      mockClient.batchGet.mockResolvedValueOnce({
        valueRanges: [
          {
            range: '_migrations!A2:B',
            values: [
              ['1', '2026-01-01T00:00:00.000Z'],
            ],
          },
        ],
      });

      const result = await engine.checkHealth(spreadsheetId, schema);

      expect(result).toEqual({
        spreadsheetId,
        currentVersion: 1,
        latestVersion: 2,
        status: ValidationStatus.UPGRADE_REQUIRED,
        missingTabs: [],
        missingColumns: {},
        canAutoMigrate: true,
      });

      expect(mockClient.batchGet).toHaveBeenCalledTimes(1);
      expect(mockClient.batchGet).toHaveBeenCalledWith(spreadsheetId, ['_migrations!A2:B']);
    });

    it('fallbacks to version 1 if _migrations exists but contains no data rows', async () => {
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        properties: { title: 'Empty Migrations' },
        sheets: [
          { properties: { sheetId: 999, title: '_migrations' } },
        ],
      });

      mockClient.batchGet.mockResolvedValueOnce({
        valueRanges: [{ range: '_migrations!A2:B', values: [] }],
      });

      const result = await engine.checkHealth(spreadsheetId, schema);

      expect(result.currentVersion).toBe(1);
      expect(result.status).toBe(ValidationStatus.UPGRADE_REQUIRED);
    });

    it('3. Spreadsheet with _migrations containing current version -> returns READY', async () => {
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        properties: { title: 'V2 Sheet' },
        sheets: [
          { properties: { sheetId: 999, title: '_migrations' } },
          { properties: { sheetId: 1, title: 'Users' } },
          { properties: { sheetId: 2, title: 'Settings' } },
        ],
      });

      // 1. _migrations read
      mockClient.batchGet.mockResolvedValueOnce({
        valueRanges: [
          {
            range: '_migrations!A2:B',
            values: [
              ['1', '2026-01-01T00:00:00.000Z'],
              ['2', '2026-01-02T00:00:00.000Z'],
            ],
          },
        ],
      });

      // 2. tabs row 1 read
      mockClient.batchGet.mockResolvedValueOnce({
        valueRanges: [
          { range: "'Users'!1:1", values: [['id', 'name', 'email', 'extra']] },
          { range: "'Settings'!1:1", values: [['key', 'value']] },
        ],
      });

      const result = await engine.checkHealth(spreadsheetId, schema);

      expect(result).toEqual({
        spreadsheetId,
        currentVersion: 2,
        latestVersion: 2,
        status: ValidationStatus.READY,
        missingTabs: [],
        missingColumns: {},
        canAutoMigrate: false,
      });

      expect(mockClient.batchGet).toHaveBeenCalledTimes(2);
      expect(mockClient.batchGet).toHaveBeenNthCalledWith(2, spreadsheetId, [
        "'Users'!1:1",
        "'Settings'!1:1",
      ]);
    });

    it('4. Spreadsheet with missing column on current version -> returns CORRUPTED', async () => {
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        properties: { title: 'V2 Corrupted Sheet' },
        sheets: [
          { properties: { sheetId: 999, title: '_migrations' } },
          { properties: { sheetId: 1, title: 'Users' } },
          { properties: { sheetId: 2, title: 'Settings' } },
        ],
      });

      mockClient.batchGet.mockResolvedValueOnce({
        valueRanges: [
          {
            range: '_migrations!A2:B',
            values: [['2', '2026-01-02T00:00:00.000Z']],
          },
        ],
      });

      mockClient.batchGet.mockResolvedValueOnce({
        valueRanges: [
          { range: "'Users'!1:1", values: [['id', 'name']] }, // 'email' missing
          { range: "'Settings'!1:1", values: [['key', 'value']] },
        ],
      });

      const result = await engine.checkHealth(spreadsheetId, schema);

      expect(result).toEqual({
        spreadsheetId,
        currentVersion: 2,
        latestVersion: 2,
        status: ValidationStatus.CORRUPTED,
        missingTabs: [],
        missingColumns: {
          Users: ['email'],
        },
        canAutoMigrate: false,
      });
    });

    it('returns CORRUPTED if a required tab is missing on current version', async () => {
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        properties: { title: 'V2 Missing Tab Sheet' },
        sheets: [
          { properties: { sheetId: 999, title: '_migrations' } },
          { properties: { sheetId: 1, title: 'Users' } },
          // 'Settings' is completely missing
        ],
      });

      mockClient.batchGet.mockResolvedValueOnce({
        valueRanges: [
          {
            range: '_migrations!A2:B',
            values: [['2', '2026-01-02T00:00:00.000Z']],
          },
        ],
      });

      mockClient.batchGet.mockResolvedValueOnce({
        valueRanges: [
          { range: "'Users'!1:1", values: [['id', 'name', 'email']] },
        ],
      });

      const result = await engine.checkHealth(spreadsheetId, schema);

      expect(result).toEqual({
        spreadsheetId,
        currentVersion: 2,
        latestVersion: 2,
        status: ValidationStatus.CORRUPTED,
        missingTabs: ['Settings'],
        missingColumns: {},
        canAutoMigrate: false,
      });
    });

    it('5. Spreadsheet with version > app version -> returns INCOMPATIBLE', async () => {
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        properties: { title: 'Future Sheet' },
        sheets: [
          { properties: { sheetId: 999, title: '_migrations' } },
          { properties: { sheetId: 1, title: 'Users' } },
        ],
      });

      mockClient.batchGet.mockResolvedValueOnce({
        valueRanges: [
          {
            range: '_migrations!A2:B',
            values: [['3', '2026-10-01T00:00:00.000Z']],
          },
        ],
      });

      const result = await engine.checkHealth(spreadsheetId, schema);

      expect(result).toEqual({
        spreadsheetId,
        currentVersion: 3,
        latestVersion: 2,
        status: ValidationStatus.INCOMPATIBLE,
        missingTabs: [],
        missingColumns: {},
        canAutoMigrate: false,
      });

      // No structural validation attempted
      expect(mockClient.batchGet).toHaveBeenCalledTimes(1);
    });
  });

  describe('repair', () => {
    it('6. repair() restores missing tabs and columns after creating safety backup', async () => {
      // 1. Initial checkHealth:
      // Metadata: Users exists, Settings missing
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        properties: { title: 'Quozen Group' },
        sheets: [
          { properties: { sheetId: 999, title: '_migrations' } },
          { properties: { sheetId: 10, title: 'Users' } },
        ],
      });
      // _migrations read: version 2
      mockClient.batchGet.mockResolvedValueOnce({
        valueRanges: [{ range: '_migrations!A2:B', values: [['2', '...']] }],
      });
      // Row 1 read: Users missing 'email'
      mockClient.batchGet.mockResolvedValueOnce({
        valueRanges: [{ range: "'Users'!1:1", values: [['id', 'name']] }],
      });

      // 2. Fetch metadata for repair execution
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        properties: { title: 'Quozen Group' },
        sheets: [
          { properties: { sheetId: 999, title: '_migrations' } },
          { properties: { sheetId: 10, title: 'Users' } },
        ],
      });

      // 3. BatchUpdate for adding 'Settings' tab
      mockClient.batchUpdate.mockResolvedValueOnce({
        replies: [{ addSheet: { properties: { sheetId: 20, title: 'Settings' } } }],
      });

      // 4. BatchUpdate for writing headers to 'Settings'
      mockClient.batchUpdate.mockResolvedValueOnce({});

      // 5. BatchGet row 1 of Users for column repair
      mockClient.batchGet.mockResolvedValueOnce({
        valueRanges: [{ range: "'Users'!1:1", values: [['id', 'name']] }],
      });

      // 6. BatchUpdate for appendDimension and updateCells on Users
      mockClient.batchUpdate.mockResolvedValueOnce({});

      // 7. Final checkHealth to verify READY
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        properties: { title: 'Quozen Group' },
        sheets: [
          { properties: { sheetId: 999, title: '_migrations' } },
          { properties: { sheetId: 10, title: 'Users' } },
          { properties: { sheetId: 20, title: 'Settings' } },
        ],
      });
      mockClient.batchGet.mockResolvedValueOnce({
        valueRanges: [{ range: '_migrations!A2:B', values: [['2', '...']] }],
      });
      mockClient.batchGet.mockResolvedValueOnce({
        valueRanges: [
          { range: "'Users'!1:1", values: [['id', 'name', 'email']] },
          { range: "'Settings'!1:1", values: [['key', 'value']] },
        ],
      });

      await engine.repair(spreadsheetId, schema, { customBackupName: 'Pre-repair backup' });

      // Verify backup was created
      expect(mockClient.createBackup).toHaveBeenCalledWith(
        spreadsheetId,
        'Pre-repair backup'
      );

      // Verify addSheet was called for Settings with frozen header row
      expect(mockClient.batchUpdate).toHaveBeenCalledWith(
        spreadsheetId,
        expect.arrayContaining([
          expect.objectContaining({
            addSheet: expect.objectContaining({
              properties: expect.objectContaining({
                title: 'Settings',
                gridProperties: { frozenRowCount: 1 },
              }),
            }),
          }),
        ])
      );

      // Verify column repair (appendDimension + updateCells for email)
      expect(mockClient.batchUpdate).toHaveBeenCalledWith(
        spreadsheetId,
        expect.arrayContaining([
          expect.objectContaining({
            appendDimension: {
              sheetId: 10,
              dimension: 'COLUMNS',
              length: 1,
            },
          }),
          expect.objectContaining({
            updateCells: expect.objectContaining({
              range: expect.objectContaining({
                sheetId: 10,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 2,
                endColumnIndex: 3,
              }),
            }),
          }),
        ])
      );
    });

    it('throws error when attempting to repair INCOMPATIBLE schema', async () => {
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        properties: { title: 'Future Sheet' },
        sheets: [{ properties: { sheetId: 999, title: '_migrations' } }],
      });
      mockClient.batchGet.mockResolvedValueOnce({
        valueRanges: [{ range: '_migrations!A2:B', values: [['3', '...']] }],
      });

      await expect(engine.repair(spreadsheetId, schema)).rejects.toThrow(
        'Cannot repair incompatible schema'
      );

      expect(mockClient.createBackup).not.toHaveBeenCalled();
    });

    it('automatically delegates to migrate when UPGRADE_REQUIRED', async () => {
      // 1. Initial checkHealth -> UPGRADE_REQUIRED (v1)
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        properties: { title: 'V1 Sheet' },
        sheets: [{ properties: { sheetId: 1, title: 'Users' } }],
      });

      // 2. migrate() calls checkHealth
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        properties: { title: 'V1 Sheet' },
        sheets: [{ properties: { sheetId: 1, title: 'Users' } }],
      });

      // 3. migrate() ensures _migrations tab
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        properties: { title: 'V1 Sheet' },
        sheets: [{ properties: { sheetId: 1, title: 'Users' } }],
      });
      // addSheet for _migrations
      mockClient.batchUpdate.mockResolvedValueOnce({
        replies: [{ addSheet: { properties: { sheetId: 999, title: '_migrations' } } }],
      });
      // updateCells headers for _migrations
      mockClient.batchUpdate.mockResolvedValueOnce({});

      // 4. migration 2 up
      const m2Up = vi.fn().mockResolvedValue(null);
      // appendCells for migration 2
      mockClient.batchUpdate.mockResolvedValueOnce({});

      // 5. checkHealth after migrate() -> READY
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        properties: { title: 'V1 Sheet' },
        sheets: [
          { properties: { sheetId: 999, title: '_migrations' } },
          { properties: { sheetId: 1, title: 'Users' } },
          { properties: { sheetId: 2, title: 'Settings' } },
        ],
      });
      mockClient.batchGet.mockResolvedValueOnce({
        valueRanges: [{ range: '_migrations!A2:B', values: [['2', '...']] }],
      });
      mockClient.batchGet.mockResolvedValueOnce({
        valueRanges: [
          { range: "'Users'!1:1", values: [['id', 'name', 'email']] },
          { range: "'Settings'!1:1", values: [['key', 'value']] },
        ],
      });

      const migrations: Migration[] = [{ version: 2, up: m2Up, down: vi.fn() }];

      await engine.repair(spreadsheetId, schema, {}, migrations);

      expect(m2Up).toHaveBeenCalledWith(mockClient, spreadsheetId);
      expect(mockClient.createBackup).toHaveBeenCalled();
      expect(mockClient.acquireLock).toHaveBeenCalled();
      expect(mockClient.releaseLock).toHaveBeenCalled();
    });
  });

  describe('migrate', () => {
    it('7. migrate() runs migrations and updates _migrations tab after creating safety backup', async () => {
      // 1. checkHealth -> UPGRADE_REQUIRED (v1)
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        properties: { title: 'V1 Sheet' },
        sheets: [
          { properties: { sheetId: 999, title: '_migrations' } },
        ],
      });
      mockClient.batchGet.mockResolvedValueOnce({
        valueRanges: [{ range: '_migrations!A2:B', values: [['1', '...']] }],
      });

      // 2. ensure _migrations metadata
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        properties: { title: 'V1 Sheet' },
        sheets: [
          { properties: { sheetId: 999, title: '_migrations' } },
        ],
      });

      // 3. migrations
      const m1Up = vi.fn().mockResolvedValue(null);
      const m2Up = vi.fn().mockResolvedValue(null);
      const migrations: Migration[] = [
        { version: 1, up: m1Up, down: vi.fn() },
        { version: 2, up: m2Up, down: vi.fn() },
      ];

      // appendCells for migration 2
      mockClient.batchUpdate.mockResolvedValueOnce({});

      const result = await engine.migrate(spreadsheetId, schema, migrations, {
        customBackupName: 'Pre-migration backup',
      });

      expect(result).toEqual({ success: true, applied: [2] });

      // Verify safety backup
      expect(mockClient.createBackup).toHaveBeenCalledWith(
        spreadsheetId,
        'Pre-migration backup'
      );

      // Verify lock lifecycle
      expect(mockClient.acquireLock).toHaveBeenCalled();
      expect(mockClient.releaseLock).toHaveBeenCalled();

      // Verify m1 was skipped (already applied) and m2 was applied
      expect(m1Up).not.toHaveBeenCalled();
      expect(m2Up).toHaveBeenCalledWith(mockClient, spreadsheetId);

      // Verify _migrations was appended with version 2
      expect(mockClient.batchUpdate).toHaveBeenCalledWith(
        spreadsheetId,
        expect.arrayContaining([
          expect.objectContaining({
            appendCells: expect.objectContaining({
              sheetId: 999,
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

    it('throws error when migrating INCOMPATIBLE schema', async () => {
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        sheets: [{ properties: { sheetId: 999, title: '_migrations' } }],
      });
      mockClient.batchGet.mockResolvedValueOnce({
        valueRanges: [{ range: '_migrations!A2:B', values: [['5', '...']] }],
      });

      await expect(engine.migrate(spreadsheetId, schema, [])).rejects.toThrow(
        'Cannot migrate incompatible schema'
      );

      expect(mockClient.createBackup).not.toHaveBeenCalled();
      expect(mockClient.acquireLock).not.toHaveBeenCalled();
    });

    it('rolls back with restoreBackup and releases lock on failure', async () => {
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        sheets: [{ properties: { sheetId: 999, title: '_migrations' } }],
      });
      mockClient.batchGet.mockResolvedValueOnce({
        valueRanges: [{ range: '_migrations!A2:B', values: [['1', '...']] }],
      });
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        sheets: [{ properties: { sheetId: 999, title: '_migrations' } }],
      });

      const badUp = vi.fn().mockRejectedValue(new Error('Syntax error in migration'));
      const migrations: Migration[] = [{ version: 2, up: badUp, down: vi.fn() }];

      await expect(engine.migrate(spreadsheetId, schema, migrations)).rejects.toThrow(
        'Syntax error in migration'
      );

      expect(mockClient.restoreBackup).toHaveBeenCalledWith('backup-123', spreadsheetId);
      expect(mockClient.releaseLock).toHaveBeenCalled();
    });
  });

  describe('initializeFile', () => {
    it('creates _migrations tab and stamps version row when missing', async () => {
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        sheets: [{ properties: { sheetId: 1, title: 'Sheet1' } }],
      });
      mockClient.batchUpdate.mockResolvedValueOnce({
        replies: [{ addSheet: { properties: { sheetId: 777 } } }],
      });
      mockClient.batchUpdate.mockResolvedValueOnce({});

      await engine.initializeFile(spreadsheetId, 2);

      expect(mockClient.batchUpdate).toHaveBeenCalledWith(
        spreadsheetId,
        expect.arrayContaining([
          expect.objectContaining({
            addSheet: { properties: { title: '_migrations', hidden: true } },
          }),
        ])
      );
      expect(mockClient.batchUpdate).toHaveBeenCalledWith(
        spreadsheetId,
        expect.arrayContaining([
          expect.objectContaining({
            updateCells: expect.objectContaining({
              range: expect.objectContaining({ sheetId: 777 }),
              rows: expect.arrayContaining([
                expect.objectContaining({
                  values: [
                    { userEnteredValue: { stringValue: 'version' } },
                    { userEnteredValue: { stringValue: 'migrated_at' } },
                  ],
                }),
                expect.objectContaining({
                  values: [
                    { userEnteredValue: { numberValue: 2 } },
                    expect.objectContaining({ userEnteredValue: expect.any(Object) }),
                  ],
                }),
              ]),
            }),
          }),
        ])
      );
    });

    it('updates version row when _migrations tab already exists', async () => {
      mockClient.getSpreadsheetMetadata.mockResolvedValueOnce({
        sheets: [{ properties: { sheetId: 888, title: '_migrations' } }],
      });
      mockClient.batchUpdate.mockResolvedValueOnce({});

      await engine.initializeFile(spreadsheetId, 2);

      expect(mockClient.batchUpdate).toHaveBeenCalledWith(
        spreadsheetId,
        expect.arrayContaining([
          expect.objectContaining({
            updateCells: expect.objectContaining({
              range: expect.objectContaining({ sheetId: 888 }),
            }),
          }),
        ])
      );
    });
  });
});

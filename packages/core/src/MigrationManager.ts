import { GoogleSheetsFetchClient } from './GoogleSheetsFetchClient.js';
import { Migration } from './types.js';

export class MigrationManager {
  private client: GoogleSheetsFetchClient;

  constructor(client: GoogleSheetsFetchClient) {
    this.client = client;
  }

  async runMigrations(
    spreadsheetId: string,
    migrations: Migration[]
  ): Promise<{ success: boolean; applied: number[] }> {
    const clientUuid =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : Math.random().toString(36).substring(2) + Date.now().toString(36);

    let lockAcquired = false;
    try {
      // 1. Acquire lock
      await this.client.acquireLock(spreadsheetId, clientUuid);
      lockAcquired = true;

      // 2. Check if _migrations tab exists, create and initialize if missing
      const metadata = await this.client.getSpreadsheet(spreadsheetId);
      const sheets = metadata.sheets || [];
      const migrationsSheet = sheets.find(
        (s: any) => s.properties?.title === '_migrations'
      );

      let currentVersion = 0;
      let migrationsSheetId: number;

      if (!migrationsSheet) {
        // Initialize _migrations sheet
        const addResult = await this.client.batchUpdate(spreadsheetId, [
          {
            addSheet: {
              properties: {
                title: '_migrations',
                hidden: true,
              },
            },
          },
        ]);

        migrationsSheetId = addResult.replies[0].addSheet.properties.sheetId;

        // Write headers and initial version 0 row
        await this.client.batchUpdate(spreadsheetId, [
          {
            updateCells: {
              rows: [
                {
                  values: [
                    { userEnteredValue: { stringValue: 'version' } },
                    { userEnteredValue: { stringValue: 'migrated_at' } },
                  ],
                },
                {
                  values: [
                    { userEnteredValue: { numberValue: 0 } },
                    { userEnteredValue: { stringValue: new Date().toISOString() } },
                  ],
                },
              ],
              fields: 'userEnteredValue',
              range: {
                sheetId: migrationsSheetId,
                startRowIndex: 0,
                startColumnIndex: 0,
              },
            },
          },
        ]);
      } else {
        migrationsSheetId = migrationsSheet.properties.sheetId;

        // Read migration history
        const getResult = await this.client.batchGet(spreadsheetId, [
          '_migrations!A:B',
        ]);
        const rows = getResult.valueRanges?.[0]?.values || [];

        for (let i = 1; i < rows.length; i++) {
          const val = parseInt(rows[i][0], 10);
          if (!isNaN(val) && val > currentVersion) {
            currentVersion = val;
          }
        }
      }

      // 3. Identify pending migrations
      const sortedMigrations = [...migrations].sort((a, b) => a.version - b.version);
      const pendingMigrations = sortedMigrations.filter(
        m => m.version > currentVersion
      );

      if (pendingMigrations.length === 0) {
        return { success: true, applied: [] };
      }

      // 4. Create backup
      const backupId = await this.client.createBackup(spreadsheetId);

      const applied: number[] = [];
      try {
        // 5. Execute up() functions sequentially
        for (const migration of pendingMigrations) {
          await migration.up(this.client, spreadsheetId);

          // Record version in _migrations tab
          await this.client.batchUpdate(spreadsheetId, [
            {
              appendCells: {
                sheetId: migrationsSheetId,
                rows: [
                  {
                    values: [
                      { userEnteredValue: { numberValue: migration.version } },
                      {
                        userEnteredValue: {
                          stringValue: new Date().toISOString(),
                        },
                      },
                    ],
                  },
                ],
                fields: 'userEnteredValue',
              },
            },
          ]);

          applied.push(migration.version);
        }

        // Cleanup backup on success
        try {
          if (typeof (this.client as any).deleteFile === 'function') {
            await (this.client as any).deleteFile(backupId);
          }
        } catch {
          // Non-blocking backup deletion failure
        }

        return { success: true, applied };
      } catch (migrationError) {
        // 6. Rollback using backup
        try {
          await this.client.restoreBackup(backupId, spreadsheetId);
        } catch {
          // If restore fails, we log it or let it bubble? 
          // We still throw the original migrationError to indicate failure.
        }
        // Cleanup backup even on failure if restore was already done (optional)
        throw migrationError;
      }
    } finally {
      // 7. Release lock
      if (lockAcquired) {
        try {
          await this.client.releaseLock(spreadsheetId, clientUuid);
        } catch {
          // Non-blocking release failure in finally block
        }
      }
    }
  }
}

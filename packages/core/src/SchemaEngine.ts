import {
  GoogleSheetsFetchClient,
  GoogleSheetsFetchClientOptions,
} from './GoogleSheetsFetchClient.js';
import {
  LifecycleOptions,
  Migration,
  SchemaDefinition,
  SchemaStatusDTO,
  TabDefinition,
  ValidationStatus,
} from './types.js';

export class SchemaEngine {
  public readonly client: GoogleSheetsFetchClient;

  constructor(
    clientOrOptions: GoogleSheetsFetchClient | GoogleSheetsFetchClientOptions
  ) {
    if (
      clientOrOptions instanceof GoogleSheetsFetchClient ||
      typeof (clientOrOptions as any)?.getSpreadsheetMetadata === 'function' ||
      typeof (clientOrOptions as any)?.batchGet === 'function'
    ) {
      this.client = clientOrOptions as GoogleSheetsFetchClient;
    } else {
      this.client = new GoogleSheetsFetchClient(clientOrOptions);
    }
  }

  async checkHealth(
    spreadsheetId: string,
    schema: SchemaDefinition
  ): Promise<SchemaStatusDTO> {
    // 1. Fetch spreadsheet metadata in 1 call:
    // GET /v4/spreadsheets/${id}?fields=properties.title,sheets.properties(sheetId,title)
    const metadata = await this.client.getSpreadsheetMetadata(
      spreadsheetId,
      'properties.title,sheets.properties(sheetId,title)'
    );

    const sheets: any[] = metadata.sheets || [];

    // 2. Extract all sheet titles (trimmed and lowercased)
    const sheetMap = new Map<string, { sheetId: number; title: string }>();
    for (const s of sheets) {
      if (s.properties?.title) {
        sheetMap.set(s.properties.title.trim().toLowerCase(), {
          sheetId: s.properties.sheetId,
          title: s.properties.title,
        });
      }
    }

    // 3. Check for _migrations tab:
    let currentVersion: number;
    const hasMigrationsTab = sheetMap.has('_migrations');

    if (!hasMigrationsTab) {
      // The spreadsheet has never been migrated by gdocs-schema.
      currentVersion = sheets.length > 0 ? 1 : 0;
      if (currentVersion < schema.version) {
        // Zero extra network calls made!
        return {
          spreadsheetId,
          currentVersion,
          latestVersion: schema.version,
          status: ValidationStatus.UPGRADE_REQUIRED,
          missingTabs: [],
          missingColumns: {},
          canAutoMigrate: true,
        };
      }
    } else {
      // Fetch _migrations!A2:B via batchGet
      const batchGetResult = await this.client.batchGet(spreadsheetId, [
        '_migrations!A2:B',
      ]);
      const rows = batchGetResult?.valueRanges?.[0]?.values || [];
      let maxVersion: number | null = null;
      for (const row of rows) {
        if (row && row[0] !== undefined && row[0] !== null) {
          const val = parseInt(String(row[0]).trim(), 10);
          if (!isNaN(val)) {
            if (maxVersion === null || val > maxVersion) {
              maxVersion = val;
            }
          }
        }
      }
      // If no rows exist, fallback to currentVersion = 1
      currentVersion = maxVersion !== null ? maxVersion : 1;
    }

    // 4. Evaluate Version State:
    // currentVersion > schema.version: Client app is outdated.
    if (currentVersion > schema.version) {
      return {
        spreadsheetId,
        currentVersion,
        latestVersion: schema.version,
        status: ValidationStatus.INCOMPATIBLE,
        missingTabs: [],
        missingColumns: {},
        canAutoMigrate: false,
      };
    }

    // currentVersion < schema.version: Document needs migration.
    if (currentVersion < schema.version) {
      return {
        spreadsheetId,
        currentVersion,
        latestVersion: schema.version,
        status: ValidationStatus.UPGRADE_REQUIRED,
        missingTabs: [],
        missingColumns: {},
        canAutoMigrate: true,
      };
    }

    // currentVersion === schema.version:
    // Document has been migrated to the expected version.
    // Now perform structural column validation (batchGet of row 1 across all schema tabs)
    const missingTabs: string[] = [];
    const existingTabsToFetch: { schemaTab: TabDefinition; actualTitle: string }[] = [];

    for (const tab of schema.tabs) {
      const existing = sheetMap.get(tab.name.trim().toLowerCase());
      if (!existing) {
        missingTabs.push(tab.name);
      } else {
        existingTabsToFetch.push({
          schemaTab: tab,
          actualTitle: existing.title,
        });
      }
    }

    const missingColumns: Record<string, string[]> = {};

    if (existingTabsToFetch.length > 0) {
      const ranges = existingTabsToFetch.map(t => `'${t.actualTitle}'!1:1`);
      const headerResult = await this.client.batchGet(spreadsheetId, ranges);
      const valueRanges = headerResult?.valueRanges || [];

      for (let i = 0; i < existingTabsToFetch.length; i++) {
        const { schemaTab } = existingTabsToFetch[i];
        const rangeData = valueRanges[i];
        const rowValues = rangeData?.values?.[0] || [];
        const headerSet = new Set(
          rowValues.map((h: any) => String(h).trim())
        );

        const tabMissingCols: string[] = [];
        for (const col of schemaTab.columns) {
          if (col.required === false) {
            continue;
          }
          if (!headerSet.has(col.name)) {
            tabMissingCols.push(col.name);
          }
        }

        if (tabMissingCols.length > 0) {
          missingColumns[schemaTab.name] = tabMissingCols;
        }
      }
    }

    const isCorrupted =
      missingTabs.length > 0 || Object.keys(missingColumns).length > 0;

    return {
      spreadsheetId,
      currentVersion,
      latestVersion: schema.version,
      status: isCorrupted ? ValidationStatus.CORRUPTED : ValidationStatus.READY,
      missingTabs,
      missingColumns,
      canAutoMigrate: false,
    };
  }

  async repair(
    spreadsheetId: string,
    schema: SchemaDefinition,
    options?: LifecycleOptions,
    migrations?: Migration[]
  ): Promise<void> {
    let actualOptions: LifecycleOptions = {};
    let actualMigrations: Migration[] = [];

    if (Array.isArray(options)) {
      actualMigrations = options;
      if (migrations && !Array.isArray(migrations)) {
        actualOptions = migrations as LifecycleOptions;
      }
    } else {
      if (options) {
        actualOptions = { ...options };
        if (options.migrations) {
          actualMigrations = options.migrations;
        }
      }
      if (migrations && Array.isArray(migrations)) {
        actualMigrations = migrations;
      }
    }

    // 1. If checkHealth() is INCOMPATIBLE, throw Error
    let health = await this.checkHealth(spreadsheetId, schema);
    if (health.status === ValidationStatus.INCOMPATIBLE) {
      throw new Error('Cannot repair incompatible schema');
    }

    // 2. If checkHealth() is UPGRADE_REQUIRED, automatically delegate to migrate()
    let backupAlreadyCreated = false;
    if (health.status === ValidationStatus.UPGRADE_REQUIRED) {
      await this.migrate(
        spreadsheetId,
        schema,
        actualMigrations,
        actualOptions
      );
      backupAlreadyCreated = actualOptions.createBackup !== false;
      health = await this.checkHealth(spreadsheetId, schema);
      if (health.status === ValidationStatus.READY) {
        return;
      }
      if (health.status === ValidationStatus.INCOMPATIBLE) {
        throw new Error('Cannot repair incompatible schema');
      }
    }

    if (health.status === ValidationStatus.READY) {
      return;
    }

    // 3. If options?.createBackup !== false, create a Drive safety backup
    let backupId: string | undefined;
    if (!backupAlreadyCreated && actualOptions.createBackup !== false) {
      backupId = await this.client.createBackup(
        spreadsheetId,
        actualOptions.customBackupName
      );
    }

    try {
      // Fetch spreadsheet metadata to get current sheet IDs & titles
      const metadata = await this.client.getSpreadsheetMetadata(
        spreadsheetId,
        'properties.title,sheets.properties(sheetId,title)'
      );
      const sheets: any[] = metadata.sheets || [];
      const existingSheetMap = new Map<string, { sheetId: number; title: string }>();
      for (const s of sheets) {
        if (s.properties?.title) {
          existingSheetMap.set(s.properties.title.trim().toLowerCase(), {
            sheetId: s.properties.sheetId,
            title: s.properties.title,
          });
        }
      }

      // 4. For any missing tab in schema.tabs:
      //    - Call batchUpdate with addSheet (title, frozen header row).
      //    - Write column headers to row 1.
      for (const tab of schema.tabs) {
        const existing = existingSheetMap.get(tab.name.trim().toLowerCase());
        if (!existing) {
          const addResult = await this.client.batchUpdate(spreadsheetId, [
            {
              addSheet: {
                properties: {
                  title: tab.name,
                  gridProperties: {
                    frozenRowCount: 1,
                  },
                },
              },
            },
          ]);

          const newSheetId = addResult?.replies?.[0]?.addSheet?.properties?.sheetId;

          if (tab.columns.length > 0 && newSheetId !== undefined) {
            await this.client.batchUpdate(spreadsheetId, [
              {
                updateCells: {
                  range: {
                    sheetId: newSheetId,
                    startRowIndex: 0,
                    endRowIndex: 1,
                    startColumnIndex: 0,
                    endColumnIndex: tab.columns.length,
                  },
                  rows: [
                    {
                      values: tab.columns.map(col => ({
                        userEnteredValue: { stringValue: col.name },
                      })),
                    },
                  ],
                  fields: 'userEnteredValue',
                },
              },
            ]);
          }
        }
      }

      // 5. For existing tabs missing columns:
      //    - Append missing column dimensions.
      //    - Insert missing header values into row 1.
      for (const tab of schema.tabs) {
        const existing = existingSheetMap.get(tab.name.trim().toLowerCase());
        if (!existing) continue;

        const headerRes = await this.client.batchGet(spreadsheetId, [
          `'${existing.title}'!1:1`,
        ]);
        const rowValues = headerRes?.valueRanges?.[0]?.values?.[0] || [];
        const existingHeaders = rowValues.map((h: any) => String(h).trim());
        const existingSet = new Set(existingHeaders);

        const missingCols = tab.columns
          .filter(
            col =>
              col.required !== false &&
              !existingSet.has(col.name)
          )
          .map(col => col.name);

        if (missingCols.length > 0) {
          const startIndex = existingHeaders.length;
          await this.client.batchUpdate(spreadsheetId, [
            {
              appendDimension: {
                sheetId: existing.sheetId,
                dimension: 'COLUMNS',
                length: missingCols.length,
              },
            },
            {
              updateCells: {
                range: {
                  sheetId: existing.sheetId,
                  startRowIndex: 0,
                  endRowIndex: 1,
                  startColumnIndex: startIndex,
                  endColumnIndex: startIndex + missingCols.length,
                },
                rows: [
                  {
                    values: missingCols.map(colName => ({
                      userEnteredValue: { stringValue: colName },
                    })),
                  },
                ],
                fields: 'userEnteredValue',
              },
            },
          ]);
        }
      }

      // 6. Verify structure is now READY
      const finalHealth = await this.checkHealth(spreadsheetId, schema);
      if (finalHealth.status !== ValidationStatus.READY) {
        throw new Error(`Repair failed: schema is still ${finalHealth.status}`);
      }

      // Cleanup ephemeral backup on success unless keepBackup is requested
      if (backupId && !actualOptions.keepBackup) {
        try {
          await this.client.deleteFile(backupId);
        } catch {
          // Non-blocking cleanup failure
        }
      }
    } catch (repairError) {
      if (backupId) {
        try {
          await this.client.restoreBackup(backupId, spreadsheetId);
        } catch {
          // secondary restore error ignored
        }
      }
      throw repairError;
    }
  }

  async migrate(
    spreadsheetId: string,
    schema: SchemaDefinition,
    migrations: Migration[],
    options?: LifecycleOptions
  ): Promise<{ success: boolean; applied: number[] }> {
    // 1. If checkHealth() is INCOMPATIBLE, throw error
    const health = await this.checkHealth(spreadsheetId, schema);
    if (health.status === ValidationStatus.INCOMPATIBLE) {
      throw new Error('Cannot migrate incompatible schema');
    }

    // 2. If options?.createBackup !== false, create a Drive safety backup
    let backupId: string | undefined;
    if (options?.createBackup !== false) {
      backupId = await this.client.createBackup(
        spreadsheetId,
        options?.customBackupName
      );
    }

    // 3. Acquire lock via acquireLock
    const clientUuid =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : Math.random().toString(36).substring(2) + Date.now().toString(36);

    let lockAcquired = false;
    try {
      await this.client.acquireLock(spreadsheetId, clientUuid);
      lockAcquired = true;

      // 4. Ensure _migrations tab exists
      const metadata = await this.client.getSpreadsheetMetadata(
        spreadsheetId,
        'properties.title,sheets.properties(sheetId,title)'
      );
      const sheets: any[] = metadata.sheets || [];
      const migrationsSheet = sheets.find(
        s => (s.properties?.title || '').trim().toLowerCase() === '_migrations'
      );

      let migrationsSheetId: number;
      if (!migrationsSheet) {
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

        const initialRows: any[] = [
          {
            values: [
              { userEnteredValue: { stringValue: 'version' } },
              { userEnteredValue: { stringValue: 'migrated_at' } },
            ],
          },
        ];

        const sorted = [...migrations].sort((a, b) => a.version - b.version);
        const pending = sorted.filter(m => m.version > health.currentVersion);

        if (health.currentVersion > 0 && pending.length === 0) {
          initialRows.push({
            values: [
              { userEnteredValue: { numberValue: health.currentVersion } },
              { userEnteredValue: { stringValue: new Date().toISOString() } },
            ],
          });
        }

        await this.client.batchUpdate(spreadsheetId, [
          {
            updateCells: {
              rows: initialRows,
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
      }

      // 5. Filter migrations where m.version > currentVersion sorted ascending
      const sortedMigrations = [...migrations].sort((a, b) => a.version - b.version);
      const pendingMigrations = sortedMigrations.filter(
        m => m.version > health.currentVersion
      );

      // 6. Sequentially run await migration.up(client, spreadsheetId)
      // 7. Append { version, migrated_at: ISOString } to _migrations
      const applied: number[] = [];
      for (const migration of pendingMigrations) {
        await migration.up(this.client, spreadsheetId);

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

      // Cleanup ephemeral backup on success unless keepBackup is requested
      if (backupId && !options?.keepBackup) {
        try {
          await this.client.deleteFile(backupId);
        } catch {
          // Non-blocking cleanup failure
        }
      }

      return { success: true, applied };
    } catch (migrationError) {
      if (backupId) {
        try {
          await this.client.restoreBackup(backupId, spreadsheetId);
        } catch {
          // secondary restore error ignored
        }
      }
      throw migrationError;
    } finally {
      // 8. Release lock via releaseLock
      if (lockAcquired) {
        try {
          await this.client.releaseLock(spreadsheetId, clientUuid);
        } catch {
          // Non-blocking release failure
        }
      }
    }
  }

  async initializeFile(spreadsheetId: string, version: number): Promise<void> {
    try {
      const metadata = await this.client.getSpreadsheetMetadata(
        spreadsheetId,
        'properties.title,sheets.properties(sheetId,title)'
      );
      const sheets: any[] = metadata?.sheets || [];
      const migrationsSheet = sheets.find(
        s => (s.properties?.title || '').trim().toLowerCase() === '_migrations'
      );

      let migrationsSheetId: number;
      if (!migrationsSheet) {
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
      } else {
        migrationsSheetId = migrationsSheet.properties.sheetId;
      }

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
                  { userEnteredValue: { numberValue: version } },
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
    } catch {
      // Non-fatal if sheet already exists or batchUpdate fails
    }
  }
}

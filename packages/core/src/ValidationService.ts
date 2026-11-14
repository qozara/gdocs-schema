import { GoogleSheetsFetchClient } from './GoogleSheetsFetchClient.js';
import { MigrationManager } from './MigrationManager.js';
import { SchemaEngine } from './SchemaEngine.js';
import { SchemaValidator } from './SchemaValidator.js';
import {
  ConflictError,
  SchemaIncompatibleError,
  ValidationStatus,
  type ColumnDefinition,
  type Migration,
  type SchemaDefinition,
  type SchemaStatusDTO,
  type TabDefinition,
} from './types.js';
import type { GoogleHttpClient } from './googleTypes.js';

export { ValidationStatus };

export interface ValidationServiceOptions {
  httpClient?: GoogleHttpClient;
  defaultSchema?: SchemaDefinition;
  migrations?: Migration[];
  appPropertyPrefix?: string;
  defaultFileType?: string;
  useSchemaEngine?: boolean;
  requireTokenOnConstruct?: boolean;
}

function isGoogleHttpClient(value: unknown): value is GoogleHttpClient {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'fetch' in value &&
      typeof (value as GoogleHttpClient).fetch === 'function'
  );
}

export class ValidationService {
  private static inFlightMigrations = new Map<string, Promise<{ backupFileId: string }>>();

  public client: GoogleSheetsFetchClient;
  public engine: SchemaEngine;

  private getToken: () => string | null;
  private httpClient?: GoogleHttpClient;
  private defaultSchema?: SchemaDefinition;
  private migrations: Migration[];
  private appPropertyPrefix: string;
  private defaultFileType?: string;
  private useSchemaEngine: boolean;

  constructor(
    getToken: () => string | null,
    httpClientOrOptions?: GoogleHttpClient | ValidationServiceOptions
  ) {
    this.getToken = getToken;
    const options: ValidationServiceOptions = isGoogleHttpClient(httpClientOrOptions)
      ? { httpClient: httpClientOrOptions }
      : (httpClientOrOptions ?? {});

    if (options.requireTokenOnConstruct) {
      const token = this.getToken();
      if (!token) {
        throw new Error('ValidationService requires a valid Google access token.');
      }
    }

    this.httpClient = options.httpClient;
    this.defaultSchema = options.defaultSchema;
    this.migrations = options.migrations ?? [];
    this.appPropertyPrefix = options.appPropertyPrefix ?? 'quomida';
    this.defaultFileType = options.defaultFileType;
    this.useSchemaEngine = options.useSchemaEngine ?? false;

    const fetchImpl: typeof fetch = this.httpClient
      ? (this.httpClient.fetch.bind(this.httpClient) as typeof fetch)
      : (url: string | Request | URL, init?: RequestInit) => {
          const finalInit = init ? { ...init } : {};
          if (finalInit.method === 'GET' && finalInit.headers) {
            const headers = new Headers(finalInit.headers as HeadersInit);
            headers.delete('Content-Type');
            finalInit.headers = headers;
          }
          return globalThis.fetch(url, finalInit);
        };

    this.client = new GoogleSheetsFetchClient({
      accessToken: this.getToken,
      fetchImpl,
    });
    this.engine = new SchemaEngine(this.client);
  }

  private ensureTokenIfUsingDefaultClient(): void {
    if (this.client instanceof GoogleSheetsFetchClient && !this.getToken()) {
      throw new Error('ValidationService requires a valid Google access token.');
    }
  }

  private async getFileMetadata(
    spreadsheetId: string
  ): Promise<{ appProperties?: Record<string, string>; modifiedTime?: string }> {
    if (this.client instanceof GoogleSheetsFetchClient) {
      const token = this.getToken();
      const url = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=appProperties,modifiedTime`;
      const headers = { Authorization: `Bearer ${token}` };
      try {
        const res = this.httpClient
          ? await this.httpClient.fetch(url, { headers })
          : await fetch(url, { headers });
        if (!res.ok) return {};
        return (await res.json()) as {
          appProperties?: Record<string, string>;
          modifiedTime?: string;
        };
      } catch {
        return {};
      }
    }
    return (this.client as GoogleSheetsFetchClient).getFileAppProperties(spreadsheetId);
  }

  private assertNoConcurrencyConflict(
    currentModifiedStr: string | undefined,
    expectedLastModified: string
  ): void {
    const currentModified = currentModifiedStr ? new Date(currentModifiedStr).getTime() : 0;
    const expectedModified = new Date(expectedLastModified).getTime();
    if (currentModified > 0 && expectedModified > 0 && currentModified > expectedModified) {
      throw new ConflictError('Spreadsheet has been modified since it was last fetched.');
    }
  }

  public async createBackup(spreadsheetId: string, customName?: string): Promise<string> {
    this.ensureTokenIfUsingDefaultClient();
    return this.client.createBackup(spreadsheetId, customName);
  }

  public async initializeFile(spreadsheetId: string, version?: number): Promise<void> {
    this.ensureTokenIfUsingDefaultClient();
    const targetVersion = version ?? this.defaultSchema?.version ?? 1;
    await this.engine.initializeFile(spreadsheetId, targetVersion);
    await this.updateFileMetadata(spreadsheetId, ValidationStatus.READY, targetVersion);
  }

  public async updateFileMetadata(
    spreadsheetId: string,
    status: ValidationStatus,
    schemaVersion?: number
  ): Promise<void> {
    const version = schemaVersion ?? this.defaultSchema?.version ?? 1;
    const prefix = this.appPropertyPrefix;
    const properties: Record<string, string> = {
      [`${prefix}_validation_status`]: status,
      [`${prefix}_validation_time`]: new Date().toISOString(),
      [`${prefix}_schema_version`]: String(version),
    };
    if (this.defaultFileType) {
      properties[`${prefix}_type`] = this.defaultFileType;
      properties.version = '1.0';
    }
    await this.client.updateFileAppProperties(spreadsheetId, properties).catch(() => {});
  }

  public async checkHealth(
    spreadsheetId: string,
    schema?: SchemaDefinition
  ): Promise<SchemaStatusDTO & { valid: boolean; errors: string[]; lastModifiedTime: string }> {
    const targetSchema = schema ?? this.defaultSchema;
    if (!targetSchema) {
      throw new Error('ValidationService.checkHealth requires a SchemaDefinition.');
    }

    this.ensureTokenIfUsingDefaultClient();

    if (this.useSchemaEngine) {
      const result = await this.engine.checkHealth(spreadsheetId, targetSchema);
      return {
        ...result,
        valid: result.valid ?? result.status === ValidationStatus.READY,
        errors: result.errors ?? [],
        lastModifiedTime: result.lastModifiedTime || new Date().toISOString(),
      };
    }

    let currentVersion = 0;
    let lastModifiedTime = new Date().toISOString();

    try {
      const meta = await this.getFileMetadata(spreadsheetId);
      if (meta.modifiedTime) lastModifiedTime = meta.modifiedTime;
      const versionKey = `${this.appPropertyPrefix}_schema_version`;
      currentVersion = parseInt(meta.appProperties?.[versionKey] || '0', 10);
    } catch {
      // Ignore error reading app properties
    }

    try {
      const migrationsRes = await this.client.batchGet(spreadsheetId, ['_migrations!A2:B']);
      const rows = migrationsRes?.valueRanges?.[0]?.values || [];
      let maxMigratedVersion = 0;
      for (const row of rows) {
        const v = parseInt(row[0], 10);
        if (!isNaN(v) && v > maxMigratedVersion) {
          maxMigratedVersion = v;
        }
      }
      if (maxMigratedVersion > currentVersion) {
        currentVersion = maxMigratedVersion;
        await this.client
          .updateFileAppProperties(spreadsheetId, {
            [`${this.appPropertyPrefix}_schema_version`]: currentVersion.toString(),
          })
          .catch(() => {});
      }
    } catch {
      // Ignore if _migrations tab is missing or unreadable
    }

    const validator = new SchemaValidator(this.client);
    const result = await validator.validateStructure(spreadsheetId, targetSchema);

    const missingTabs: string[] = [];
    const missingColumns: Record<string, string[]> = {};

    for (const err of result.errors) {
      const tabMatch = err.match(/^Tab "([^"]+)" is missing$/);
      if (tabMatch) {
        missingTabs.push(tabMatch[1]);
      }
      const colMatch = err.match(/^Tab "([^"]+)" is missing column "([^"]+)"$/);
      if (colMatch) {
        const [, tab, col] = colMatch;
        if (!missingColumns[tab]) missingColumns[tab] = [];
        missingColumns[tab].push(col);
      }
    }

    let status = ValidationStatus.READY;
    let canAutoMigrate = false;

    if (!result.valid) {
      if (currentVersion > 0 && currentVersion < targetSchema.version) {
        status = ValidationStatus.UPGRADE_REQUIRED;
        canAutoMigrate = true;
      } else {
        status = ValidationStatus.CORRUPTED;
      }
    }

    return {
      spreadsheetId,
      currentVersion,
      latestVersion: targetSchema.version,
      status,
      valid: result.valid,
      missingTabs,
      missingColumns,
      canAutoMigrate,
      lastModifiedTime,
      errors: result.errors,
    };
  }

  public async repairFile(
    spreadsheetId: string,
    schemaOrExpectedLastModified?: SchemaDefinition | string,
    expectedLastModified?: string
  ): Promise<{ backupFileId: string }> {
    const schema =
      typeof schemaOrExpectedLastModified === 'object'
        ? schemaOrExpectedLastModified
        : this.defaultSchema;
    const expectedMod =
      typeof schemaOrExpectedLastModified === 'string'
        ? schemaOrExpectedLastModified
        : expectedLastModified;

    if (!schema) {
      throw new Error('ValidationService.repairFile requires a SchemaDefinition.');
    }

    this.ensureTokenIfUsingDefaultClient();

    if (expectedMod) {
      if (this.useSchemaEngine) {
        const res = await this.client.getFileAppProperties(spreadsheetId);
        this.assertNoConcurrencyConflict(res?.modifiedTime, expectedMod);
      } else {
        const meta = await this.getFileMetadata(spreadsheetId);
        this.assertNoConcurrencyConflict(meta.modifiedTime, expectedMod);
      }
    }

    if (this.useSchemaEngine) {
      try {
        await this.engine.repair(spreadsheetId, schema, undefined, this.migrations);
        await this.updateFileMetadata(spreadsheetId, ValidationStatus.READY, schema.version);
        return { backupFileId: '' };
      } catch (e: any) {
        if (e?.message?.toLowerCase().includes('incompatible')) {
          throw new SchemaIncompatibleError(
            'Cannot repair spreadsheet: the schema is from a newer version of the application.'
          );
        }
        throw e;
      }
    }

    const client = this.client;
    const backupFileId = await client.createBackup(spreadsheetId);
    const metadata = await client.getSpreadsheet(spreadsheetId);
    const sheets = metadata.sheets || [];

    const requests: any[] = [];
    let tabsAdded = false;
    const existingTitles = new Set(sheets.map((s: any) => s.properties?.title));
    for (const tab of schema.tabs) {
      if (!existingTitles.has(tab.name)) {
        requests.push({
          addSheet: {
            properties: {
              title: tab.name,
            },
          },
        });
      }
    }

    if (requests.length > 0) {
      tabsAdded = true;
      await client.batchUpdate(spreadsheetId, requests);
      requests.length = 0;
    }

    const refreshedMeta = tabsAdded ? await client.getSpreadsheet(spreadsheetId) : metadata;
    const currentSheets = refreshedMeta.sheets || sheets;

    const tabsToFetch: string[] = schema.tabs
      .filter((t: TabDefinition) => currentSheets.some((s: any) => s.properties?.title === t.name))
      .map((t: TabDefinition) => t.name);

    if (tabsToFetch.length > 0) {
      const ranges = tabsToFetch.map((name) => `${name}!1:1`);
      const batchGetResult = await client.batchGet(spreadsheetId, ranges);
      const valueRanges = batchGetResult.valueRanges || [];

      for (let i = 0; i < tabsToFetch.length; i++) {
        const tabName = tabsToFetch[i];
        const tabSchema = schema.tabs.find((t: TabDefinition) => t.name === tabName);
        if (!tabSchema) continue;

        const sheetId = currentSheets.find((s: any) => s.properties?.title === tabName)?.properties
          ?.sheetId;
        if (sheetId === undefined) continue;

        const valueRange = valueRanges[i];
        const rows = valueRange?.values || [];
        const headers = rows[0] || [];
        const headerSet = new Set(headers.map((h: any) => String(h).trim()));

        const missingCols = tabSchema.columns.filter(
          (c: ColumnDefinition) => !headerSet.has(c.name)
        );

        if (missingCols.length > 0) {
          requests.push({
            appendDimension: {
              sheetId,
              dimension: 'COLUMNS',
              length: missingCols.length,
            },
          });

          requests.push({
            updateCells: {
              rows: [
                {
                  values: missingCols.map((col: ColumnDefinition) => ({
                    userEnteredValue: { stringValue: col.name },
                  })),
                },
              ],
              fields: 'userEnteredValue',
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: headers.length,
                endColumnIndex: headers.length + missingCols.length,
              },
            },
          });
        }
      }

      if (requests.length > 0) {
        await client.batchUpdate(spreadsheetId, requests);
      }
    }

    const prefix = this.appPropertyPrefix;
    await client.updateFileAppProperties(spreadsheetId, {
      [`${prefix}_validation_status`]: ValidationStatus.READY,
      [`${prefix}_validation_time`]: new Date().toISOString(),
      [`${prefix}_schema_version`]: schema.version.toString(),
    });

    return { backupFileId };
  }

  public async migrateFile(
    spreadsheetId: string,
    schemaOrExpectedLastModified?: SchemaDefinition | string,
    migrations?: Migration[],
    expectedLastModified?: string
  ): Promise<{ backupFileId: string }> {
    const schema =
      typeof schemaOrExpectedLastModified === 'object'
        ? schemaOrExpectedLastModified
        : this.defaultSchema;
    const targetMigrations =
      typeof schemaOrExpectedLastModified === 'object'
        ? (migrations ?? this.migrations)
        : this.migrations;
    const expectedMod =
      typeof schemaOrExpectedLastModified === 'string'
        ? schemaOrExpectedLastModified
        : expectedLastModified;

    if (!schema) {
      throw new Error('ValidationService.migrateFile requires a SchemaDefinition.');
    }

    this.ensureTokenIfUsingDefaultClient();

    const inFlight = ValidationService.inFlightMigrations.get(spreadsheetId);
    if (inFlight) {
      return inFlight;
    }

    const migrationPromise = (async (): Promise<{ backupFileId: string }> => {
      if (expectedMod) {
        if (this.useSchemaEngine) {
          const res = await this.client.getFileAppProperties(spreadsheetId);
          this.assertNoConcurrencyConflict(res?.modifiedTime, expectedMod);
        } else {
          const meta = await this.getFileMetadata(spreadsheetId);
          this.assertNoConcurrencyConflict(meta.modifiedTime, expectedMod);
        }
      }

      if (this.useSchemaEngine) {
        try {
          await this.engine.migrate(spreadsheetId, schema, targetMigrations);
          await this.updateFileMetadata(spreadsheetId, ValidationStatus.READY, schema.version);
          return { backupFileId: '' };
        } catch (e: any) {
          if (e?.message?.toLowerCase().includes('incompatible')) {
            throw new SchemaIncompatibleError(
              'Cannot migrate spreadsheet: the schema is from a newer version of the application.'
            );
          }
          throw e;
        }
      }

      const backupFileId = await this.client.createBackup(spreadsheetId);
      const migrationManager = new MigrationManager(this.client);
      await migrationManager.runMigrations(spreadsheetId, targetMigrations);

      const prefix = this.appPropertyPrefix;
      await this.client.updateFileAppProperties(spreadsheetId, {
        [`${prefix}_validation_status`]: ValidationStatus.READY,
        [`${prefix}_validation_time`]: new Date().toISOString(),
        [`${prefix}_schema_version`]: schema.version.toString(),
      });

      return { backupFileId };
    })();

    ValidationService.inFlightMigrations.set(spreadsheetId, migrationPromise);
    try {
      return await migrationPromise;
    } finally {
      ValidationService.inFlightMigrations.delete(spreadsheetId);
    }
  }
}

import { GoogleSheetsFetchClient } from './GoogleSheetsFetchClient.js';

export enum ValidationStatus {
  READY = 'READY',
  UPGRADE_REQUIRED = 'UPGRADE_REQUIRED',
  CORRUPTED = 'CORRUPTED',
  INCOMPATIBLE = 'INCOMPATIBLE',
}

export interface SchemaStatusDTO {
  spreadsheetId: string;
  currentVersion: number;
  latestVersion: number;
  status: ValidationStatus;
  missingTabs: string[];
  missingColumns: Record<string, string[]>;
  canAutoMigrate: boolean;
  lastModifiedTime?: string;
}

export interface LifecycleOptions {
  createBackup?: boolean;
  customBackupName?: string;
  migrations?: Migration[];
  keepBackup?: boolean;
}

export interface ColumnDefinition {
  name: string;
  type?: 'string' | 'number' | 'boolean' | 'integer';
  required?: boolean;
}

export interface TabDefinition {
  name: string;
  columns: ColumnDefinition[];
  rowSchema?: any; // JSON Schema for AJV
}

export interface SchemaDefinition {
  version: number;
  tabs: TabDefinition[];
}

export interface Migration {
  version: number;
  up: (client: GoogleSheetsFetchClient, spreadsheetId: string) => Promise<any>;
  down: (client: GoogleSheetsFetchClient, spreadsheetId: string) => Promise<any>;
}

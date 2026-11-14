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
  valid?: boolean;
  errors?: string[];
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

export class ConflictError extends Error {
  constructor(message = 'Data has been modified by another user.') {
    super(message);
    this.name = 'ConflictError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SchemaIncompatibleError extends Error {
  constructor(
    message = 'The underlying spreadsheet schema was created or upgraded by a newer version of the application. Please update or reinstall the app.'
  ) {
    super(message);
    this.name = 'SchemaIncompatibleError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface Migration {
  version: number;
  up: (client: GoogleSheetsFetchClient, spreadsheetId: string) => Promise<any>;
  down: (client: GoogleSheetsFetchClient, spreadsheetId: string) => Promise<any>;
}

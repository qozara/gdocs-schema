import { GoogleSheetsFetchClient } from './GoogleSheetsFetchClient.js';

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

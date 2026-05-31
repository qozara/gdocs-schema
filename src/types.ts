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

export interface IStorageLayer {
  // Drive / Files
  listFiles(query: string, fields?: string): Promise<any[]>;
  getFile(fileId: string, options?: { alt?: string; fields?: string }): Promise<any>;
  createFile(
    name: string,
    mimeType: string,
    properties?: Record<string, string>,
    content?: string
  ): Promise<string>;
  getLastModified(fileId: string): Promise<string>;
  updateFile(fileId: string, metadata?: any, content?: string): Promise<any>;
  deleteFile(fileId: string): Promise<void>;

  // Permissions
  createPermission(
    fileId: string,
    role: string,
    type: string,
    emailAddress?: string
  ): Promise<any>;
  listPermissions(fileId: string): Promise<any[]>;
  deletePermission(fileId: string, permissionId: string): Promise<void>;

  // Sheets
  createSpreadsheet(
    title: string,
    sheetTitles: string[],
    properties?: Record<string, string>
  ): Promise<string>;
  getSpreadsheet(spreadsheetId: string, fields?: string): Promise<any>;
  batchGetValues(spreadsheetId: string, ranges: string[]): Promise<any[]>;
  batchUpdateValues(
    spreadsheetId: string,
    data: { range: string; values: any[][] }[]
  ): Promise<void>;
  appendValues(spreadsheetId: string, range: string, values: any[][]): Promise<void>;
  updateValues(spreadsheetId: string, range: string, values: any[][]): Promise<void>;
  batchUpdateSpreadsheet(spreadsheetId: string, requests: any[]): Promise<void>;
}

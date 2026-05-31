import { GoogleSheetsFetchClient } from './GoogleSheetsFetchClient.js';
import { SchemaDefinition } from './types.js';

export class SchemaValidator {
  private client: GoogleSheetsFetchClient;

  constructor(client: GoogleSheetsFetchClient) {
    this.client = client;
  }

  async validateStructure(
    spreadsheetId: string,
    schema: SchemaDefinition
  ): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    // 1. Fetch spreadsheet metadata
    const metadata = await this.client.getSpreadsheet(spreadsheetId);
    const sheets = metadata.sheets || [];
    const sheetTitles = new Set(
      sheets.map((s: any) => s.properties?.title).filter(Boolean)
    );

    // 2. Identify missing tabs and existing tabs to fetch headers for
    const tabsToFetch: string[] = [];
    for (const tab of schema.tabs) {
      if (!sheetTitles.has(tab.name)) {
        errors.push(`Tab "${tab.name}" is missing`);
      } else {
        tabsToFetch.push(tab.name);
      }
    }

    if (tabsToFetch.length === 0) {
      return { valid: errors.length === 0, errors };
    }

    // 3. Fetch the first row (headers) of the existing tabs
    const ranges = tabsToFetch.map(name => `${name}!1:1`);
    const batchGetResult = await this.client.batchGet(spreadsheetId, ranges);
    const valueRanges = batchGetResult.valueRanges || [];

    // 4. Validate columns for each tab
    for (let i = 0; i < tabsToFetch.length; i++) {
      const tabName = tabsToFetch[i];
      const tabSchema = schema.tabs.find(t => t.name === tabName);
      if (!tabSchema) continue;

      const valueRange = valueRanges[i];
      const rows = valueRange?.values || [];
      const headers = rows[0] || [];

      const headerSet = new Set(headers.map((h: any) => String(h).trim()));

      for (const col of tabSchema.columns) {
        if (!headerSet.has(col.name)) {
          errors.push(`Tab "${tabName}" is missing column "${col.name}"`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

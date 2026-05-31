import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchemaValidator } from './SchemaValidator.js';
import { SchemaDefinition } from './types.js';
import { GoogleSheetsFetchClient } from './GoogleSheetsFetchClient.js';

describe('SchemaValidator', () => {
  let mockClient: any;
  let validator: SchemaValidator;

  const schema: SchemaDefinition = {
    version: 1,
    tabs: [
      {
        name: 'Users',
        columns: [
          { name: 'id', type: 'string', required: true },
          { name: 'name', type: 'string' },
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
      getSpreadsheet: vi.fn(),
      batchGet: vi.fn(),
    };
    validator = new SchemaValidator(mockClient as unknown as GoogleSheetsFetchClient);
  });

  it('should return valid true when spreadsheet matches schema', async () => {
    // 1. Mock getSpreadsheet to return both tabs
    mockClient.getSpreadsheet.mockResolvedValueOnce({
      sheets: [
        { properties: { title: 'Users' } },
        { properties: { title: 'Settings' } },
      ],
    });

    // 2. Mock batchGet to return correct headers
    mockClient.batchGet.mockResolvedValueOnce({
      valueRanges: [
        { range: 'Users!1:1', values: [['id', 'name', 'email']] }, // email is extra, which is allowed
        { range: 'Settings!1:1', values: [['key', 'value']] },
      ],
    });

    const result = await validator.validateStructure('sheet-id', schema);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(mockClient.getSpreadsheet).toHaveBeenCalledWith('sheet-id');
    expect(mockClient.batchGet).toHaveBeenCalledWith('sheet-id', ['Users!1:1', 'Settings!1:1']);
  });

  it('should report missing tabs', async () => {
    // Mock only one tab present
    mockClient.getSpreadsheet.mockResolvedValueOnce({
      sheets: [{ properties: { title: 'Users' } }],
    });

    // Mock headers for the single tab
    mockClient.batchGet.mockResolvedValueOnce({
      valueRanges: [{ range: 'Users!1:1', values: [['id', 'name']] }],
    });

    const result = await validator.validateStructure('sheet-id', schema);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Tab "Settings" is missing');
  });

  it('should report missing columns in tabs', async () => {
    mockClient.getSpreadsheet.mockResolvedValueOnce({
      sheets: [
        { properties: { title: 'Users' } },
        { properties: { title: 'Settings' } },
      ],
    });

    mockClient.batchGet.mockResolvedValueOnce({
      valueRanges: [
        { range: 'Users!1:1', values: [['name']] }, // id is missing
        { range: 'Settings!1:1', values: [[]] }, // all columns missing
      ],
    });

    const result = await validator.validateStructure('sheet-id', schema);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Tab "Users" is missing column "id"');
    expect(result.errors).toContain('Tab "Settings" is missing column "key"');
    expect(result.errors).toContain('Tab "Settings" is missing column "value"');
  });

  it('should return immediately if all tabs are missing', async () => {
    mockClient.getSpreadsheet.mockResolvedValueOnce({
      sheets: [],
    });

    const result = await validator.validateStructure('sheet-id', schema);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Tab "Users" is missing');
    expect(result.errors).toContain('Tab "Settings" is missing');
    expect(mockClient.batchGet).not.toHaveBeenCalled();
  });
});

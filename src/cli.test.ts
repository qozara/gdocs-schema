import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createProgram } from './cli.js';
import * as fs from 'fs';
import { SchemaValidator } from './SchemaValidator.js';
import { GoogleSheetsFetchClient } from './GoogleSheetsFetchClient.js';
import { computeSchemaHash } from './SchemaHasher.js';

vi.mock('fs');
vi.mock('./SchemaValidator.js');
vi.mock('./MigrationManager.js');
vi.mock('./GoogleSheetsFetchClient.js');
vi.mock('./SchemaHasher.js');

describe('CLI commands', () => {
  let consoleLogMock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogMock = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GOOGLE_ACCESS_TOKEN = 'env-token';
  });

  it('should inspect spreadsheet and output validation status, hash and version', async () => {
    const mockSchema = {
      version: 1,
      tabs: [{ name: 'Users', columns: [{ name: 'id' }] }],
    };

    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(mockSchema));
    vi.mocked(computeSchemaHash).mockResolvedValue('hash-12345');

    const mockValidatorInstance = {
      validateStructure: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
    };
    vi.mocked(SchemaValidator).mockImplementation(() => mockValidatorInstance as any);

    const mockClientInstance = {
      getSpreadsheet: vi.fn().mockResolvedValue({
        sheets: [{ properties: { title: '_migrations' } }],
      }),
      batchGet: vi.fn().mockResolvedValue({
        valueRanges: [{ values: [['version'], ['3']] }],
      }),
    };
    vi.mocked(GoogleSheetsFetchClient).mockImplementation(() => mockClientInstance as any);

    const program = createProgram();
    await program.parseAsync([
      'node',
      'gdocs-schema',
      'inspect',
      'spreadsheet-123',
      '--schema',
      'schema.json',
    ]);

    expect(mockValidatorInstance.validateStructure).toHaveBeenCalledWith(
      'spreadsheet-123',
      mockSchema
    );
    expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining('Structure is VALID'));
    expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining('Schema Hash: hash-12345'));
    expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining('Current Version: 3'));
  });

  it('should repair missing columns', async () => {
    const mockSchema = {
      version: 1,
      tabs: [{ name: 'Users', columns: [{ name: 'id' }, { name: 'email' }] }],
    };

    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(mockSchema));

    const mockValidatorInstance = {
      validateStructure: vi.fn().mockResolvedValue({
        valid: false,
        errors: ['Tab "Users" is missing column "email"'],
      }),
    };
    vi.mocked(SchemaValidator).mockImplementation(() => mockValidatorInstance as any);

    const mockClientInstance = {
      getSpreadsheet: vi.fn().mockResolvedValue({
        sheets: [{ properties: { sheetId: 101, title: 'Users' } }],
      }),
      batchGet: vi.fn().mockResolvedValue({
        valueRanges: [{ values: [['id']] }], // 'email' is missing, headers length = 1
      }),
      batchUpdate: vi.fn().mockResolvedValue({}),
    };
    vi.mocked(GoogleSheetsFetchClient).mockImplementation(() => mockClientInstance as any);

    const program = createProgram();
    await program.parseAsync([
      'node',
      'gdocs-schema',
      'repair',
      'spreadsheet-123',
      '--schema',
      'schema.json',
    ]);

    expect(mockClientInstance.batchUpdate).toHaveBeenCalledWith(
      'spreadsheet-123',
      expect.arrayContaining([
        expect.objectContaining({
          appendDimension: expect.objectContaining({
            sheetId: 101,
            dimension: 'COLUMNS',
            length: 1,
          }),
        }),
        expect.objectContaining({
          updateCells: expect.objectContaining({
            range: expect.objectContaining({
              sheetId: 101,
              startColumnIndex: 1,
            }),
          }),
        }),
      ])
    );
    expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining('Repair complete'));
  });
});

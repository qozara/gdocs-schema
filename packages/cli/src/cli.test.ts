import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createProgram } from './cli.js';
import * as fs from 'fs';
import { SchemaValidator, GoogleSheetsFetchClient, computeSchemaHash } from '@qozara/gdocs-schema';

vi.mock('fs');
vi.mock('@qozara/gdocs-schema');

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

  it('should print error and help info if inspect is run without token and without schema', async () => {
    process.env.GOOGLE_ACCESS_TOKEN = '';
    const consoleErrorMock = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    const program = createProgram();
    await expect(
      program.parseAsync(['node', 'gdocs-schema', 'inspect', 'spreadsheet-123'])
    ).rejects.toThrow('exit');

    expect(consoleErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('Google Access Token is required')
    );
    expect(consoleErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('A schema file path is also required')
    );

    exitMock.mockRestore();
    consoleErrorMock.mockRestore();
  });

  it('should print init suggestion if inspect is run without schema but with token', async () => {
    const consoleErrorMock = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    const program = createProgram();
    await expect(
      program.parseAsync(['node', 'gdocs-schema', 'inspect', 'spreadsheet-123'])
    ).rejects.toThrow('exit');

    expect(consoleErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('Schema file path is required to validate')
    );
    expect(consoleLogMock).toHaveBeenCalledWith(
      expect.stringContaining('If you do not have a schema yet, you can initialize one by running:')
    );
    expect(consoleLogMock).toHaveBeenCalledWith(
      expect.stringContaining('npx gdocs-schema init spreadsheet-123')
    );

    exitMock.mockRestore();
    consoleErrorMock.mockRestore();
  });

  it('should initialize schema and metadata if init is run', async () => {
    const mockClientInstance = {
      getSpreadsheet: vi.fn().mockResolvedValue({
        properties: { title: 'My Spreadsheet' },
        sheets: [
          { properties: { title: 'Users' } },
        ],
      }),
      getFileAppProperties: vi.fn().mockResolvedValue({
        etag: 'etag123',
        appProperties: {},
      }),
      batchGet: vi.fn().mockResolvedValue({
        valueRanges: [
          { values: [['id', 'name']] },
        ],
      }),
      batchUpdate: vi.fn().mockResolvedValue({
        replies: [{ addSheet: { properties: { sheetId: 102 } } }],
      }),
      updateFileAppProperties: vi.fn().mockResolvedValue({}),
    };
    vi.mocked(GoogleSheetsFetchClient).mockImplementation(() => mockClientInstance as any);

    const writeFileSyncMock = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(['node', 'gdocs-schema', 'init', 'spreadsheet-123']);

    // Check schema written
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('my-spreadsheet-schema.json'),
      expect.stringContaining('"tabs"'),
      'utf8'
    );
    expect(writeFileSyncMock.mock.calls[0][1]).toContain('"name": "Users"');
    expect(writeFileSyncMock.mock.calls[0][1]).toContain('"name": "id"');
    expect(writeFileSyncMock.mock.calls[0][1]).toContain('"name": "name"');

    // Check _migrations tab initialized
    expect(mockClientInstance.batchUpdate).toHaveBeenCalledWith(
      'spreadsheet-123',
      expect.arrayContaining([
        expect.objectContaining({ addSheet: expect.objectContaining({ properties: expect.objectContaining({ title: '_migrations' }) }) })
      ])
    );
    expect(mockClientInstance.batchUpdate).toHaveBeenCalledWith(
      'spreadsheet-123',
      expect.arrayContaining([
        expect.objectContaining({ updateCells: expect.objectContaining({ range: expect.objectContaining({ sheetId: 102 }) }) })
      ])
    );

    // Check appProperties updated
    expect(mockClientInstance.updateFileAppProperties).toHaveBeenCalledWith(
      'spreadsheet-123',
      { schema_managed: 'true' },
      'etag123'
    );

    writeFileSyncMock.mockRestore();
  });
});

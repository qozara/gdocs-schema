import { describe, it, expect } from 'vitest';
import { computeSchemaHash } from './SchemaHasher.js';
import { SchemaDefinition } from './types.js';

describe('SchemaHasher', () => {
  const schema1: SchemaDefinition = {
    version: 1,
    tabs: [
      {
        name: 'Users',
        columns: [
          { name: 'id', type: 'string', required: true },
          { name: 'name', type: 'string' },
        ],
      },
    ],
  };

  const schema2: SchemaDefinition = {
    version: 2,
    tabs: [
      {
        name: 'Users',
        columns: [
          { name: 'id', type: 'string', required: true },
          { name: 'name', type: 'string' },
        ],
      },
    ],
  };

  const schemaAltered: SchemaDefinition = {
    version: 1,
    tabs: [
      {
        name: 'Users',
        columns: [
          { name: 'id', type: 'string', required: true },
          { name: 'email', type: 'string' }, // altered column
        ],
      },
    ],
  };

  it('should generate identical hashes for identical structures regardless of schema version', async () => {
    const hash1 = await computeSchemaHash(schema1);
    const hash2 = await computeSchemaHash(schema2);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex length
  });

  it('should generate different hashes for different structures', async () => {
    const hash1 = await computeSchemaHash(schema1);
    const hashAltered = await computeSchemaHash(schemaAltered);
    expect(hash1).not.toBe(hashAltered);
  });
});

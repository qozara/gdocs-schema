# GDocs Schema Manager (`@qozara/gdocs-schema`)

A standalone Node.js package designed to handle client-side schema validation, structural integrity hashing, concurrent migration locking, and database-like migrations for Google Spreadsheets acting as structured databases.

This package is built to be completely independent of the Quozen codebase, allowing it to be published and consumed as an external dependency.

---

## Quozen Context & Background

To ensure that this package integrates seamlessly into future phases of Quozen without interface mismatches, here is how Quozen Core currently manages spreadsheets and settings.

### 1. Database Spreadsheets Structure
Quozen uses a Google Spreadsheet as a group database. Each group spreadsheet has three required tabs:
*   **`Expenses`**:
    *   *Columns:* `id`, `date`, `description`, `amount`, `paidByUserId` (or `paidBy` in old configurations), `category`, `splits` (JSON stringified array), `meta` (JSON stringified object containing `createdAt` and `lastModified`).
*   **`Settlements`**:
    *   *Columns:* `id`, `date`, `fromUserId`, `toUserId`, `amount`, `method`, `notes`.
*   **`Members`**:
    *   *Columns:* `userId`, `email`, `name`, `role` (`owner` | `member`), `joinedAt`.

### 2. Google Drive Metadata (File Properties)
Currently, Quozen tags files inside Google Drive metadata (using Custom File Properties) rather than inside the sheet.
*   `quozen_type` = `group`
*   `version` = `1.0` (indicates the current Quozen schema version)

### 3. User Settings File (`quozen-settings.json`)
Quozen stores a centralized JSON configuration in the user's Google Drive root folder:
```json
{
  "version": 1,
  "activeGroupId": "spreadsheet_id_string",
  "groupCache": [
    {
      "id": "spreadsheet_id_string",
      "name": "Group Name",
      "role": "owner",
      "lastAccessed": "ISO-8601-timestamp"
    }
  ],
  "preferences": {
    "defaultCurrency": "USD",
    "theme": "system"
  },
  "lastUpdated": "ISO-8601-timestamp"
}
```

---

## Getting Started

### Installation

```bash
npm install @qozara/gdocs-schema
```

### Authentication
Before using the API or CLI, ensure you have a Google API OAuth2 Access Token. For the CLI, you can expose this via the `GOOGLE_ACCESS_TOKEN` environment variable.

---

## API Reference

### 1. `GoogleSheetsFetchClient`

A lightweight, zero-dependency `fetch`-based wrapper for the Google Sheets and Drive REST APIs.

```typescript
import { GoogleSheetsFetchClient } from '@qozara/gdocs-schema';

const client = new GoogleSheetsFetchClient({
  accessToken: 'YOUR_GOOGLE_ACCESS_TOKEN',
  fetchImpl: globalThis.fetch, // Optional custom fetch implementation
});
```

### 2. `SchemaHasher`

Generates a deterministic SHA-256 hash representing the structural definition (tabs and columns) of a spreadsheet schema.

```typescript
import { computeSchemaHash, SchemaDefinition } from '@qozara/gdocs-schema';

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
  ],
};

const hash = await computeSchemaHash(schema);
console.log(`Schema hash: ${hash}`);
```

### 3. `SchemaValidator`

Validates that a spreadsheet matches the structural constraints of a schema.

```typescript
import { SchemaValidator, GoogleSheetsFetchClient } from '@qozara/gdocs-schema';

const client = new GoogleSheetsFetchClient({ accessToken: '...' });
const validator = new SchemaValidator(client);

const result = await validator.validateStructure('YOUR_SPREADSHEET_ID', schema);

if (result.valid) {
  console.log('Structure is correct!');
} else {
  console.error('Validation errors:', result.errors);
}
```

### 4. `MigrationManager`

Orchestrates sequential, atomic schema migrations. Ensures operations are safe via Drive-level concurrency locking and backup/rollback mechanisms.

```typescript
import { MigrationManager, GoogleSheetsFetchClient, Migration } from '@qozara/gdocs-schema';

const client = new GoogleSheetsFetchClient({ accessToken: '...' });
const manager = new MigrationManager(client);

const migrations: Migration[] = [
  {
    version: 1,
    up: async (client, spreadsheetId) => {
      // Add sheet, modify cells, etc.
      await client.batchUpdate(spreadsheetId, [
        { addSheet: { properties: { title: 'NewTab' } } }
      ]);
    },
    down: async (client, spreadsheetId) => {
      // Revert version 1 changes
    }
  }
];

const result = await manager.runMigrations('YOUR_SPREADSHEET_ID', migrations);
console.log(`Successfully applied: ${result.applied.join(', ')}`);
```

---

## Writing Migrations

Migrations are stored as programmatic objects containing `version`, an `up` hook, and a `down` hook. Both hooks are passed the `GoogleSheetsFetchClient` and the target `spreadsheetId`.

Example:

```javascript
// migrations/1_add_roles_column.js
export const version = 1;

export async function up(client, spreadsheetId) {
  // Read existing columns to find insert position
  const meta = await client.getSpreadsheet(spreadsheetId);
  const usersTab = meta.sheets.find(s => s.properties.title === 'Users');
  
  // Send batchUpdate to append column dimension and write header cell
  await client.batchUpdate(spreadsheetId, [
    {
      appendDimension: {
        sheetId: usersTab.properties.sheetId,
        dimension: 'COLUMNS',
        length: 1
      }
    },
    {
      updateCells: {
        rows: [{ values: [{ userEnteredValue: { stringValue: 'role' } }] }],
        fields: 'userEnteredValue',
        range: {
          sheetId: usersTab.properties.sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 2 // Assuming we have 2 columns initially
        }
      }
    }
  ]);
}

export async function down(client, spreadsheetId) {
  // Revert changes if necessary (e.g. deleting the column or sheet)
}
```

---

## Command Line Interface (CLI)

The package includes a command-line tool `gdocs-schema`.

Ensure the environment variable `GOOGLE_ACCESS_TOKEN` is set, or pass it via the `--token` option.

### Commands

#### 1. Inspect
Validates a spreadsheet against a schema and outputs structural information, schema hash, and the current migration version.
```bash
npx gdocs-schema inspect <spreadsheetId> --schema <path/to/schema.json>
```

#### 2. Migrate
Runs pending migrations located in a migrations directory.
```bash
npx gdocs-schema migrate <spreadsheetId> --migrations-dir <path/to/migrations/>
```

#### 3. Repair
Appends missing columns to sheets (tabs) present in the spreadsheet to make them match the schema structure.
```bash
npx gdocs-schema repair <spreadsheetId> --schema <path/to/schema.json>
```

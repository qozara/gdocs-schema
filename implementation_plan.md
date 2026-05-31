# Implementation Plan: Independent GDocs Schema Manager

This plan focuses exclusively on building a completely independent package (`gdocs-schema`) that will be hosted in its own GitHub repository under the `qozara` organization. This package will handle schema validation, hashing, and migrations via Google Sheets directly from the client side without relying on heavy backend dependencies like `googleapis`.

Future integration into Quozen Core (Phases 2 and 3) is deferred and documented in an Architecture Decision Record (ADR) file.

## Key Architectural Decisions

1. **Hybrid Versioning**: We use a hybrid approach. A hidden `_migrations` tab stores the sequence version (an integer) to manage the step-by-step migration flow. Concurrently, a structural hash (tabs, columns, rows configuration) is computed dynamically to verify if the spreadsheet matches expectations or if it has been corrupted/tampered with outside the application.
2. **Zero `googleapis` Dependency**: To maintain a lightweight client-side profile, the package will NOT use `googleapis`. Instead, it will feature its own lightweight `fetch`-based Google APIs layer designed to be tree-shakeable and secure for frontend usage.
3. **Concurrency and Locking**: Since multiple clients could theoretically attempt migrations simultaneously, the fetch layer will incorporate a "lock" mechanism (e.g., using a specific property on the file or a lock cell) to prevent concurrent migration collisions.
4. **Safe Migrations & Rollback**: To properly manage corrupted or half-applied migrations, the migration manager will include a rollback/restore mechanism. This could be achieved by duplicating the target GDoc as a backup before applying a batch update, or by strictly enforcing that every migration provides a `down()` function to revert its specific batch requests. If a migration fails, the file is either restored from the backup or the inverse operations are applied.
5. **Standalone CLI**: The package will include its own CLI (`bin/gdocs-schema.js`) for inspecting schemas, running migrations, and debugging, without any ties to the `quozen` CLI.
6. **Separate Repository**: The package will be initialized directly in a new repository sibling to Quozen (in the `qozara` parent directory) to ensure zero cross-contamination.

## Step-by-Step Task Breakdown

You can use the following checklist to track progress incrementally.

### 1. Project Initialization
- `[x]` Initialize the standalone project directory at `../gdocs-schema` (outside Quozen, inside the `qozara` parent folder).
- `[x]` Initialize a new git repository (`git init`).
- `[x]` Set up `package.json` with build scripts (e.g., TypeScript, tsup/rollup) and dependencies (`ajv` for JSON validation, no `googleapis`).
- `[x]` Configure ESLint and Prettier for the standalone project.

### 2. Lightweight Fetch-based Google API Layer
- `[x]` Create `GoogleSheetsFetchClient.ts`.
- `[x]` Implement methods for standard operations: reading sheet metadata, `batchGet`, `batchUpdate` (for structural changes like `addSheet`, `addDimension`).
- `[x]` Implement the Lock mechanism:
    - Add `acquireLock(spreadsheetId)` (e.g., writing to a specific cell in `_migrations` or setting a Drive file property).
    - Add `releaseLock(spreadsheetId)`.
- `[x]` Implement Backup/Restore hooks:
    - Add `createBackup(spreadsheetId)` (e.g., using Google Drive API to copy the file).
    - Add `restoreBackup(backupId, spreadsheetId)`.

### 3. Schema Data Structures and Hashing
- `[ ]` Define TypeScript interfaces for schemas (`SchemaDefinition`, `TabDefinition`, `ColumnDefinition`).
- `[ ]` Create `SchemaHasher.ts`.
    - Implement a deterministic hashing function (e.g., using `crypto-js` or Web Crypto API) that generates a hash based on tab names, column headers, and structural metadata.
- `[ ]` Create `SchemaValidator.ts`.
    - Implement comparison logic between a GDoc's active structure (fetched via the client) and the expected `SchemaDefinition`.

### 4. Migration Engine
- `[ ]` Create `MigrationManager.ts`.
- `[ ]` Implement logic to initialize the hidden `_migrations` sheet if missing.
- `[ ]` Implement the sequence flow with safety nets:
    1. Acquire lock.
    2. Read `current_version` from `_migrations`.
    3. Identify missing migrations from a provided array of `{ version, up(), down() }` objects.
    4. Trigger `createBackup(spreadsheetId)` before applying changes.
    5. Execute `up()` functions sequentially using `batchUpdate`.
    6. If a failure occurs, execute `restoreBackup()` or apply `down()` functions sequentially.
    7. On success, update `current_version` and release lock.

### 5. Standalone CLI Development
- `[ ]` Set up `commander` or a similar CLI framework in `src/cli.ts`.
- `[ ]` Implement `inspect <spreadsheetId>` command to validate structure and output the current hash and version.
- `[ ]` Implement `migrate <spreadsheetId>` command to run pending migrations safely.
- `[ ]` Implement `repair <spreadsheetId>` to append missing columns (if corrupted).

### 6. Testing
- `[ ]` Set up a test runner (e.g., Vitest or Jest).
- `[ ]` Write unit tests for `SchemaHasher` and validation logic.
- `[ ]` Write tests for `MigrationManager` flow, specifically simulating migration failures and verifying rollback procedures (using mocked Google API fetch responses).

### 7. Documentation
- `[ ]` Write `README.md` detailing how to instantiate the `SchemaValidator`, create safe migrations (requiring both `up` and `down`), and use the CLI.
- `[ ]` Provide a guide on how to handle schema updates and write the corresponding migration functions.

## Verification Plan

- Run unit tests to verify the schema hashing algorithm correctly produces different hashes for altered structures and identical hashes for matching structures.
- Execute the standalone CLI locally against a test spreadsheet to ensure the fetch-based API correctly applies batch updates, acquires/releases locks, and safely restores a file if a simulated migration error occurs.

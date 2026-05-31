# Architecture Decision Record: Implemented GDocs Schema Manager

## Status
Accepted (Implemented)

## Context
We needed a standalone, lightweight, and concurrency-safe schema manager and migration engine for Google Spreadsheets acting as serverless databases. The package (`@qozara/gdocs-schema`) had to run directly on the client side without relying on heavy backend SDKs like `googleapis`.

## Decisions & Implementation Details

### 1. Zero-Dependency Light Fetch API Layer
We implemented `GoogleSheetsFetchClient` using the native, browser-and-Node-compatible `fetch` API. It directly calls the Google Sheets v4 and Google Drive v3 REST endpoints. 
- Custom type definitions wrap API requests.
- Returns empty objects for successful `204 No Content` responses to support `DELETE` requests safely.

### 2. Deterministic Structural Hashing
We implemented deterministic hashing in `SchemaHasher.ts`.
- The structural definition (tab names, column configurations) is mapped to a canonical ordered JSON representation.
- Hashing uses the native Web Crypto API (`globalThis.crypto.subtle.digest`) to generate a SHA-256 hex string, ensuring browser and Node environment compatibility.

### 3. Drive-Level Concurrency Locking
To prevent simultaneous clients from running migrations on the same spreadsheet:
- We leverage Google Drive file `appProperties` to write a unique lock payload containing the client ID and acquisition timestamp.
- To guarantee atomicity, we fetch the file's latest `etag` and pass it in the `If-Match` header when saving the lock. If another client has updated the properties, Google Drive rejects the request with a `412 Precondition Failed` error, allowing the lock to fail safe.

### 4. ID-Preserving Rollback Protocol
To ensure migrations are atomic and recoverable:
- A full copy of the Google Sheet is created via the Google Drive Copy API before executing any migration.
- If a migration fails, the engine restores the previous state without changing the spreadsheet's ID (which would break external links):
  1. Copies all sheets from the backup file to the target spreadsheet.
  2. Deletes the old sheets and renames the new ones to their original names in a single atomic `batchUpdate` request.
- On success, the temporary backup file is deleted.

### 5. ESM Commander CLI
We developed a standalone command-line interface in `src/cli.ts` supporting three core operations:
- `inspect`: Validates structure, prints active hash, and gets migration version.
- `migrate`: Runs pending ESM-based migrations sequentially.
- `repair`: Safely appends missing columns to existing sheets dynamically.

## Consequences
- We have a fully functional standalone package in the sibling repository `gdocs-schema` with high coverage unit tests.
- Future integrations into Quozen Core can import this package with zero dependency bloat.

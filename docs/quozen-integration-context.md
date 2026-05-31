# Quozen Integration Context & Background

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

## Design Guidelines for Future-Proof Integration

To ensure this package works seamlessly when imported by `@quozen/core` in the future:

### A. Dual Metadata Sync (Hidden Sheet + Drive Properties)
When running migrations, the tool must update:
1.  The sequence version (integer/timestamp) in the hidden `_migrations` tab inside the spreadsheet.
2.  The Drive File Property (`version`) via the Google Drive API to ensure older versions of Quozen Core that inspect properties do not flag the file as unreadable.

### B. Matching Client Interface
The `GoogleSheetsFetchClient` created in Phase 2 should map closely to the operations found in Quozen's `GoogleDriveStorageLayer.ts`. Both clients perform:
*   `batchUpdateSpreadsheet` (updates tab titles, grid dimensions, frozen rows)
*   `batchUpdateValues` & `batchGetValues` (writes/reads matrix data from ranges)
*   `updateFile` (updates Drive properties)

This allows Quozen Core to easily wrap or supply its own fetch implementation to the package.

### C. Structural Hash Mechanism
*   The `SchemaHasher` should inspect the spreadsheet metadata (specifically sheet titles and the header rows of each sheet).
*   It computes a deterministic hash of this structure.
*   If a sheet has been altered (e.g., column removed, tab deleted), the hash will mismatch, alerting the app that the file is corrupted.

### D. Concurrency & Lock Mechanism
Since multiple clients may access the sheet at once:
*   **Acquire Lock:** Write a unique client ID and timestamp to a lock cell in `_migrations` (or a Drive file property `migration_lock`). If the lock is held (timestamp is fresh, e.g., < 1 minute old), other clients must wait or poll.
*   **Release Lock:** Clear the lock cell/property.

### E. Rollback Protocol
If any migration step fails:
*   **Backup First:** Duplicate the Drive file (`drive.files.copy`) before executing the migration sequence.
*   **Restore on Fail:** If an error occurs mid-way, delete the failed sheet and rename the backup sheet back to the original name, ensuring atomic database transitions.

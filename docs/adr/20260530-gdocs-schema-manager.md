# Architecture Decision Record: GDocs Schema Manager & Independent Package

## Context
Quozen relies on Google Spreadsheets as a serverless database. Because users have direct access to their Drive files, there is a risk that the underlying files become corrupted or structurally outdated when Quozen's schemas evolve. We need a robust mechanism to validate the structure of a GDoc, repair it if necessary, and apply automated schema migrations.

## Decision
1. **Completely Independent Package:** We will build the GDocs schema manager as a standalone Node.js package (e.g., `gdocs-schema`). This package will be initialized in a completely separate repository (e.g., `../gdocs-schema`), sibling to the Quozen repo under the `qozara` organization, ensuring zero cross-contamination.
2. **Client-Side Operation & No Heavy Dependencies:** Quozen's architecture is decentralized and designed to run from the front-end. To prevent bloating the client and avoid credential exposure, the schema manager will *not* use the heavy `googleapis` SDK. Instead, it will feature its own lightweight, fetch-based layer interacting directly with the Google Sheets REST API.
3. **Hybrid Versioning System:**
   - **Sequence Versioning:** A hidden metadata sheet (e.g., `_migrations`) will store an integer representing the current migration version. This allows sequential application of "database-like" migrations.
   - **Structural Hashing:** The package will compute a structural hash dynamically based on tabs and columns to immediately verify if a file's structure has been tampered with or corrupted outside of Quozen.
4. **Concurrency Locking:** To prevent race conditions where two clients attempt to apply migrations simultaneously, the fetch-based layer will implement a locking mechanism on the target spreadsheet.
5. **Safe Migrations & Rollback:** The migration manager will properly handle corrupted or half-applied migrations by creating a backup of the GDoc prior to applying batch updates or strictly enforcing inverse `down()` operations. This ensures files can be restored to a safe state if a migration fails.
6. **Standalone CLI:** The new package will expose its own CLI for testing and interacting with schemas independently, bypassing the Quozen Core CLI.
7. **Future Quozen Integration (Deferred):** Once the package is fully developed and published, Quozen Core will import it as a standard node dependency to automate checks upon app startup, group import, and active group changes.

## Consequences
- The development of this validation and migration engine will be isolated in its own repository, ensuring strong boundaries and reusability.
- Avoids front-end bloat by maintaining a custom, lightweight Google API fetch layer.
- Guarantees user data safety through robust backup/rollback procedures during migrations.
- Quozen Core is shielded from schema implementation details until the package is stable and tested via its standalone CLI.
- Requires careful implementation of the file locking mechanism to avoid deadlocks on the client-side.

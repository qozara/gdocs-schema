# Resume Instructions: Fix `etag` field selection in `gdocs-schema`

This document contains instructions to feed to a new agent session once you have the `gdocs-schema` repository open in your IDE.

## Context
While testing the schema remediation flow in Quozen (`feature/schemaValidation`), the application triggers an error when attempting to repair a corrupted file:

```
PATCH https://www.googleapis.com/drive/v3/files/1lUxBh-dvfUhDuLVO97LGQiEUiiwrhtKiZRwL6bjPLQk?fields=etag,appProperties 400 (Bad Request)
"invalid field selection etag"
```

The error occurs because the Google Drive API `PATCH` endpoint does not support `etag` in the `fields` query parameter.

## Root Cause
In `@qozara/gdocs-schema` (specifically `packages/core/src/GoogleSheetsFetchClient.ts`), the `fileUrl` is hardcoded to include `?fields=etag,appProperties` for several operations that perform `PATCH` requests:
1. `acquireLock`
2. `releaseLock`
3. `updateFileAppProperties`

When `PATCH` requests use this URL, the Drive API throws a 400 Bad Request.

## Next Steps for the Agent
1. Open the file `packages/core/src/GoogleSheetsFetchClient.ts` in the `gdocs-schema` project.
2. Locate the `PATCH` requests made in `acquireLock`, `releaseLock`, and `updateFileAppProperties`.
3. Modify the URL used for the `PATCH` requests so that the `fields` parameter only requests `appProperties` (e.g., `?fields=appProperties`), omitting `etag`.
   * Note: The `GET` requests should still use `?fields=etag,appProperties` to retrieve the etag.
4. Run the local tests for `gdocs-schema` to verify the logic remains intact.
5. Provide the fix so it can be built, published, and eventually updated in the `quozen` repository.

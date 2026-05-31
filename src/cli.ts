import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { GoogleSheetsFetchClient } from './GoogleSheetsFetchClient.js';
import { SchemaValidator } from './SchemaValidator.js';
import { MigrationManager } from './MigrationManager.js';
import { computeSchemaHash } from './SchemaHasher.js';

export function createProgram(): Command {
  const program = new Command();
  program
    .name('gdocs-schema')
    .description('CLI for GDocs Schema Validation and Migrations')
    .version('1.0.0');

  program
    .command('inspect <spreadsheetId>')
    .description('Inspect the spreadsheet structure and print metadata')
    .option('-t, --token <token>', 'Google API Access Token')
    .option('-s, --schema <path>', 'Path to schema JSON file')
    .action(async (spreadsheetId, options) => {
      const token = options.token || process.env.GOOGLE_ACCESS_TOKEN;
      if (!token) {
        console.error(
          'Error: Google Access Token is required (use --token or GOOGLE_ACCESS_TOKEN env var)'
        );
        process.exit(1);
      }
      if (!options.schema) {
        console.error('Error: Schema file path is required (use --schema)');
        process.exit(1);
      }

      const schemaPath = path.resolve(options.schema);
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

      const client = new GoogleSheetsFetchClient({ accessToken: token });
      const validator = new SchemaValidator(client);

      const result = await validator.validateStructure(spreadsheetId, schema);
      const hash = await computeSchemaHash(schema);

      console.log(`Validation Results for Spreadsheet ${spreadsheetId}:`);
      console.log(`- Structure is ${result.valid ? 'VALID' : 'INVALID'}`);
      if (result.errors.length > 0) {
        console.log('Errors:');
        result.errors.forEach(e => console.log(`  - ${e}`));
      }
      console.log(`- Schema Hash: ${hash}`);

      // Attempt to read current version from _migrations
      try {
        const metadata = await client.getSpreadsheet(spreadsheetId);
        const hasMigrationsTab = (metadata.sheets || []).some(
          (s: any) => s.properties?.title === '_migrations'
        );
        if (hasMigrationsTab) {
          const getResult = await client.batchGet(spreadsheetId, [
            '_migrations!A:B',
          ]);
          const rows = getResult.valueRanges?.[0]?.values || [];
          let currentVersion = 0;
          for (let i = 1; i < rows.length; i++) {
            const val = parseInt(rows[i][0], 10);
            if (!isNaN(val) && val > currentVersion) {
              currentVersion = val;
            }
          }
          console.log(`- Current Version: ${currentVersion}`);
        } else {
          console.log('- Current Version: None (_migrations sheet not initialized)');
        }
      } catch (err: any) {
        console.log(
          `- Current Version: Could not retrieve version (${err.message})`
        );
      }
    });

  program
    .command('migrate <spreadsheetId>')
    .description('Run pending migrations on the spreadsheet')
    .option('-t, --token <token>', 'Google API Access Token')
    .option('-m, --migrations-dir <dir>', 'Directory containing migration scripts')
    .action(async (spreadsheetId, options) => {
      const token = options.token || process.env.GOOGLE_ACCESS_TOKEN;
      if (!token) {
        console.error('Error: Google Access Token is required');
        process.exit(1);
      }
      if (!options.migrationsDir) {
        console.error(
          'Error: Migrations directory is required (use --migrations-dir)'
        );
        process.exit(1);
      }

      const migrationsDir = path.resolve(options.migrationsDir);
      if (!fs.existsSync(migrationsDir)) {
        console.error(
          `Error: Migrations directory does not exist: ${migrationsDir}`
        );
        process.exit(1);
      }

      const files = fs.readdirSync(migrationsDir);
      const migrations: any[] = [];
      for (const file of files) {
        if (file.endsWith('.js') || file.endsWith('.ts') || file.endsWith('.mjs')) {
          const filePath = path.resolve(migrationsDir, file);
          const module = await import(pathToFileURL(filePath).href);
          const version = module.version || module.default?.version;
          const up = module.up || module.default?.up;
          const down = module.down || module.default?.down;

          if (version !== undefined && typeof up === 'function') {
            migrations.push({ version, up, down: down || (async () => {}) });
          }
        }
      }

      console.log(`Loaded ${migrations.length} migrations.`);
      const client = new GoogleSheetsFetchClient({ accessToken: token });
      const manager = new MigrationManager(client);

      try {
        const result = await manager.runMigrations(spreadsheetId, migrations);
        console.log('Migration complete!');
        console.log(`Applied migrations: ${result.applied.join(', ') || 'None'}`);
      } catch (err: any) {
        console.error(`Migration failed: ${err.message}`);
        process.exit(1);
      }
    });

  program
    .command('repair <spreadsheetId>')
    .description('Append missing columns in the spreadsheet structure')
    .option('-t, --token <token>', 'Google API Access Token')
    .option('-s, --schema <path>', 'Path to schema JSON file')
    .action(async (spreadsheetId, options) => {
      const token = options.token || process.env.GOOGLE_ACCESS_TOKEN;
      if (!token) {
        console.error('Error: Google Access Token is required');
        process.exit(1);
      }
      if (!options.schema) {
        console.error('Error: Schema file path is required');
        process.exit(1);
      }

      const schemaPath = path.resolve(options.schema);
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

      const client = new GoogleSheetsFetchClient({ accessToken: token });
      const validator = new SchemaValidator(client);

      const validationResult = await validator.validateStructure(
        spreadsheetId,
        schema
      );
      if (validationResult.valid) {
        console.log(
          'Spreadsheet is already structurally correct. No repair needed.'
        );
        return;
      }

      console.log('Spreadsheet structure is invalid. Initiating repair...');
      const metadata = await client.getSpreadsheet(spreadsheetId);
      const sheets = metadata.sheets || [];

      // We need to fetch headers of each sheet again to figure out what is missing where
      const tabsToFetch: string[] = schema.tabs
        .filter((t: any) =>
          (sheets as any[]).some((s: any) => s.properties?.title === t.name)
        )
        .map((t: any) => t.name as string);

      if (tabsToFetch.length === 0) {
        console.error(
          'Error: Missing tabs cannot be repaired automatically. Please recreate them.'
        );
        process.exit(1);
      }

      const ranges = tabsToFetch.map(name => `${name}!1:1`);
      const batchGetResult = await client.batchGet(spreadsheetId, ranges);
      const valueRanges = batchGetResult.valueRanges || [];

      const requests: any[] = [];

      for (let i = 0; i < tabsToFetch.length; i++) {
        const tabName = tabsToFetch[i];
        const tabSchema = schema.tabs.find((t: any) => t.name === tabName);
        if (!tabSchema) continue;

        const sheetId = sheets.find((s: any) => s.properties?.title === tabName)
          ?.properties?.sheetId;
        if (sheetId === undefined) continue;

        const valueRange = valueRanges[i];
        const rows = valueRange?.values || [];
        const headers = rows[0] || [];
        const headerSet = new Set(headers.map((h: any) => String(h).trim()));

        const missingColumns = tabSchema.columns.filter(
          (c: any) => !headerSet.has(c.name)
        );

        if (missingColumns.length > 0) {
          console.log(
            `Tab "${tabName}" is missing columns: ${missingColumns
              .map((c: any) => c.name)
              .join(', ')}`
          );

          // Append missing columns as headers
          // 1. Add COLUMNS dimension
          requests.push({
            appendDimension: {
              sheetId,
              dimension: 'COLUMNS',
              length: missingColumns.length,
            },
          });

          // 2. Write headers starting from first empty column index (headers.length)
          requests.push({
            updateCells: {
              rows: [
                {
                  values: missingColumns.map((col: any) => ({
                    userEnteredValue: { stringValue: col.name },
                  })),
                },
              ],
              fields: 'userEnteredValue',
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: headers.length,
                endColumnIndex: headers.length + missingColumns.length,
              },
            },
          });
        }
      }

      if (requests.length > 0) {
        await client.batchUpdate(spreadsheetId, requests);
        console.log('Repair complete. Missing columns appended.');
      } else {
        console.log('No missing columns found in existing tabs.');
      }
    });

  return program;
}

// Self-run wrapper when invoked directly
const argv1 = process.argv[1];
if (argv1) {
  const isMain =
    import.meta.url === pathToFileURL(argv1).href ||
    argv1.endsWith('dist/cli.js') ||
    argv1.endsWith('bin/gdocs-schema.js') ||
    path.basename(argv1) === 'cli.ts';

  if (isMain) {
    const program = createProgram();
    program.parseAsync(process.argv).catch(err => {
      console.error(err);
      process.exit(1);
    });
  }
}

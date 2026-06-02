#!/usr/bin/env node
import * as dotenv from 'dotenv';
dotenv.config();
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { GoogleSheetsFetchClient } from './GoogleSheetsFetchClient.js';
import { SchemaValidator } from './SchemaValidator.js';
import { MigrationManager } from './MigrationManager.js';
import { computeSchemaHash } from './SchemaHasher.js';
import { login, CREDENTIALS_PATH } from './auth.js';

function getAccessToken(options: any): string | undefined {
  if (options.token) return options.token;
  if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN;
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      if (creds.access_token) {
        return creds.access_token;
      }
    }
  } catch (err) {
    // Ignore read/parse errors
  }
  return undefined;
}


export function createProgram(): Command {
  const program = new Command();
  program
    .name('gdocs-schema')
    .description('CLI for GDocs Schema Validation and Migrations')
    .version('1.0.0');

  program
    .command('login')
    .description('Log in to Google Drive via OAuth2')
    .action(async () => {
      try {
        await login();
      } catch (e: any) {
        console.error(`Login failed: ${e.message}`);
        process.exit(1);
      }
    });

  program
    .command('inspect <spreadsheetId>')
    .description('Inspect the spreadsheet structure and print metadata')
    .option('-t, --token <token>', 'Google API Access Token')
    .option('-s, --schema <path>', 'Path to schema JSON file')
    .action(async (spreadsheetId, options) => {
      const token = getAccessToken(options);
      if (!token) {
        console.error(
          'Error: Google Access Token is required (use "gdocs-schema login", --token or GOOGLE_ACCESS_TOKEN env var)'
        );
        if (!options.schema) {
          console.error('\nNote: A schema file path is also required (use --schema <path>).');
          console.error('A schema JSON file defines the expected sheet tabs and columns. Example:');
          console.error(JSON.stringify({
            version: 1,
            tabs: [
              {
                name: 'SheetName',
                columns: [
                  { name: 'column_name', type: 'string' }
                ]
              }
            ]
          }, null, 2));
        }
        process.exit(1);
      }
      if (!options.schema) {
        console.error('Error: Schema file path is required to validate the spreadsheet structure.');
        console.log('\nTo validate this spreadsheet, you must provide a schema using the --schema option:');
        console.log(`  npx gdocs-schema inspect ${spreadsheetId} --schema <path-to-schema.json>`);
        console.log('\nA schema JSON file defines the expected sheet tabs and columns. Example:');
        console.log(JSON.stringify({
          version: 1,
          tabs: [
            {
              name: 'Users',
              columns: [
                { name: 'id', type: 'string' },
                { name: 'name', type: 'string' }
              ]
            }
          ]
        }, null, 2));

        console.log('\n--- Attempting to inspect the spreadsheet structure and generate a starter schema... ---');
        
        try {
          const client = new GoogleSheetsFetchClient({ accessToken: token });
          const metadata = await client.getSpreadsheet(spreadsheetId);
          const sheets = metadata.sheets || [];
          const tabs: any[] = [];

          if (sheets.length > 0) {
            const sheetNames = sheets.map((s: any) => s.properties?.title).filter(Boolean);
            const ranges = sheetNames.map((name: string) => `${name}!1:1`);
            const batchGetResult = await client.batchGet(spreadsheetId, ranges);
            const valueRanges = batchGetResult.valueRanges || [];

            for (let i = 0; i < sheetNames.length; i++) {
              const tabName = sheetNames[i];
              if (tabName === '_migrations') continue;

              const valueRange = valueRanges[i];
              const rows = valueRange?.values || [];
              const headers = rows[0] || [];
              
              tabs.push({
                name: tabName,
                columns: headers.map((h: any) => ({
                  name: String(h).trim(),
                  type: 'string'
                }))
              });
            }
          }

          const starterSchema = {
            version: 1,
            tabs
          };

          console.log('\nDiscovered Spreadsheet Structure:');
          if (tabs.length === 0) {
            console.log('No data sheets found (excluding internal tracking sheets).');
          } else {
            tabs.forEach(tab => {
              const cols = tab.columns.map((c: any) => c.name).join(', ') || '(no columns)';
              console.log(`- Tab "${tab.name}" with columns: [${cols}]`);
            });
          }

          console.log('\nStarter Schema Template:');
          console.log(JSON.stringify(starterSchema, null, 2));
        } catch (err: any) {
          console.error(`\nCould not fetch spreadsheet structure automatically: ${err.message}`);
        }
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
      const token = getAccessToken(options);
      if (!token) {
        console.error('Error: Google Access Token is required (use "gdocs-schema login", --token or GOOGLE_ACCESS_TOKEN env var)');
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
      const token = getAccessToken(options);
      if (!token) {
        console.error('Error: Google Access Token is required (use "gdocs-schema login", --token or GOOGLE_ACCESS_TOKEN env var)');
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
  let isMain = false;
  try {
    isMain = fs.realpathSync(argv1) === fileURLToPath(import.meta.url);
  } catch {
    isMain =
      import.meta.url === pathToFileURL(argv1).href ||
      argv1.endsWith('dist/cli.js') ||
      argv1.endsWith('bin/gdocs-schema') ||
      argv1.endsWith('bin/gdocs-schema.js') ||
      path.basename(argv1) === 'cli.ts';
  }

  if (isMain) {
    const program = createProgram();
    program.parseAsync(process.argv).catch(err => {
      console.error(err);
      process.exit(1);
    });
  }
}

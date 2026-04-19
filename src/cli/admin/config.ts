import { Command } from 'commander';
import { printJson } from '../output.js';
import { clientFromCommand } from './_client-helper.js';

type ConfigResponse = Record<string, unknown>;

/**
 * Walk a dot-separated path into a possibly-nested object.
 * Returns undefined if any segment is missing.
 */
function getPath(obj: unknown, dotted: string): unknown {
  const parts = dotted.split('.');
  let cursor: unknown = obj;
  for (const p of parts) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[p];
  }
  return cursor;
}

/**
 * Convert a dot path + value into a nested patch body the PATCH /admin/config
 * endpoint accepts. E.g. ("instance.name", "foo") → { instance: { name: "foo" } }.
 */
function buildPatchBody(dotted: string, value: unknown): Record<string, unknown> {
  const parts = dotted.split('.');
  const root: Record<string, unknown> = {};
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const next: Record<string, unknown> = {};
    cursor[parts[i]] = next;
    cursor = next;
  }
  cursor[parts[parts.length - 1]] = value;
  return root;
}

function coerceValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function registerConfigCommands(parent: Command, _program: Command): void {
  const config = parent.command('config').description('Inspect and update runtime configuration');

  config
    .command('get [path]')
    .description('Get the full config or a single dotted path (e.g. instance.name)')
    .option('--json', 'Output as JSON (always JSON when a path is provided)')
    .action(async (pathArg: string | undefined, options, command: Command) => {
      const client = clientFromCommand(command);
      const result = await client.get<ConfigResponse>('/api/v1/admin/config');

      if (!pathArg) {
        if (options.json) printJson(result);
        else console.log(JSON.stringify(result, null, 2));
        return;
      }

      const value = getPath(result, pathArg);
      if (value === undefined) {
        console.error(`Path not found: ${pathArg}`);
        process.exit(1);
      }
      if (typeof value === 'string') {
        console.log(value);
      } else {
        console.log(JSON.stringify(value, null, 2));
      }
    });

  config
    .command('set <path> <value>')
    .description('Set a config value at a dotted path. Value is auto-coerced via JSON.parse (strings, numbers, booleans, JSON objects).')
    .option('--json', 'Output as JSON')
    .action(async (pathArg: string, rawValue: string, options, command: Command) => {
      const client = clientFromCommand(command);
      const value = coerceValue(rawValue);
      const body = buildPatchBody(pathArg, value);
      const result = await client.patch<{ restartRequired?: boolean }>('/api/v1/admin/config', body);

      if (options.json) {
        printJson({ path: pathArg, value, restartRequired: !!result.restartRequired });
      } else {
        console.log(`Set ${pathArg} = ${JSON.stringify(value)}`);
        if (result.restartRequired) {
          console.log('Note: changes require a hub restart to take effect.');
        }
      }
    });
}

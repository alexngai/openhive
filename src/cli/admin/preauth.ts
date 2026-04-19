import { Command } from 'commander';
import { renderOutput, printJson, Column } from '../output.js';
import { clientFromCommand } from './_client-helper.js';

type PreauthKey = {
  id: string;
  key?: string;
  hive_id: string | null;
  uses_left: number;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
};

const COLUMNS: Column<PreauthKey>[] = [
  { header: 'ID', get: (k) => k.id, max: 24 },
  { header: 'HIVE', get: (k) => k.hive_id ?? '-', max: 24 },
  { header: 'USES LEFT', get: (k) => k.uses_left },
  { header: 'EXPIRES', get: (k) => k.expires_at ?? 'never', max: 20 },
  { header: 'LAST USED', get: (k) => k.last_used_at ?? '-', max: 20 },
];

export function registerPreauthCommands(parent: Command, _program: Command): void {
  const preauth = parent.command('preauth').description('MAP pre-auth key management');

  preauth
    .command('create')
    .description('Create a new MAP pre-auth key')
    .option('--hive <id>', 'Hive ID to scope the key to')
    .option('--uses <n>', 'Number of uses (default: 1)', '1')
    .option('--expires-hours <n>', 'Expiry in hours from now')
    .option('--json', 'Output as JSON')
    .action(async (options, command: Command) => {
      const client = clientFromCommand(command);
      const body: Record<string, unknown> = {
        uses: parseInt(options.uses, 10),
      };
      if (options.hive) body.hive_id = options.hive;
      if (options.expiresHours) {
        const d = new Date();
        d.setHours(d.getHours() + parseInt(options.expiresHours, 10));
        body.expires_at = d.toISOString();
      }

      const created = await client.post<PreauthKey>('/api/v1/map/preauth-keys', body);
      if (options.json) {
        printJson(created);
      } else {
        console.log(`\nCreated pre-auth key:`);
        console.log(`  ID:        ${created.id}`);
        console.log(`  Key:       ${created.key}`);
        console.log(`  Uses left: ${created.uses_left}`);
        console.log(`  Expires:   ${created.expires_at ?? 'never'}`);
        console.log(`\nSave the key now — it will not be shown again.\n`);
      }
    });

  preauth
    .command('list')
    .description('List pre-auth keys')
    .option('--hive <id>', 'Filter by hive ID')
    .option('--limit <n>', 'Max results', '50')
    .option('--json', 'Output as JSON')
    .action(async (options, command: Command) => {
      const client = clientFromCommand(command);
      const result = await client.get<{ data: PreauthKey[] }>('/api/v1/map/preauth-keys', {
        hive_id: options.hive,
        limit: options.limit,
      });
      renderOutput(result.data, COLUMNS, !!options.json);
    });

  preauth
    .command('revoke <id>')
    .description('Revoke a pre-auth key')
    .option('--json', 'Output as JSON')
    .action(async (id: string, options, command: Command) => {
      const client = clientFromCommand(command);
      await client.del(`/api/v1/map/preauth-keys/${encodeURIComponent(id)}`);
      if (options.json) {
        printJson({ revoked: id });
      } else {
        console.log(`Revoked pre-auth key ${id}`);
      }
    });
}

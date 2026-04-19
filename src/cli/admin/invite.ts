import { Command } from 'commander';
import { renderOutput, printJson, Column } from '../output.js';
import { clientFromCommand } from './_client-helper.js';

type Invite = {
  id: string;
  code: string;
  uses_left: number;
  expires_at?: string | null;
  created_at?: string;
};

const COLUMNS: Column<Invite>[] = [
  { header: 'ID', get: (i) => i.id, max: 24 },
  { header: 'CODE', get: (i) => i.code, max: 24 },
  { header: 'USES LEFT', get: (i) => i.uses_left },
  { header: 'EXPIRES', get: (i) => i.expires_at ?? 'never', max: 20 },
];

export function registerInviteCommands(parent: Command, _program: Command): void {
  const invite = parent.command('invite').description('Invite code management');

  invite
    .command('list')
    .description('List invite codes')
    .option('--active-only', 'Only show active (not-used-up, not-expired) codes')
    .option('--limit <n>', 'Max results', '50')
    .option('--json', 'Output as JSON')
    .action(async (options, command: Command) => {
      const client = clientFromCommand(command);
      const result = await client.get<{ data: Invite[] }>('/api/v1/admin/invites', {
        active_only: options.activeOnly,
        limit: options.limit,
      });
      renderOutput(result.data, COLUMNS, !!options.json);
    });

  invite
    .command('create')
    .description('Create a new invite code')
    .option('--uses <n>', 'Number of uses (default: 1)', '1')
    .option('--expires-days <n>', 'Expiry in days from now')
    .option('--json', 'Output as JSON')
    .action(async (options, command: Command) => {
      const client = clientFromCommand(command);
      const body: Record<string, unknown> = {
        uses: parseInt(options.uses, 10),
      };
      if (options.expiresDays) body.expires_in_days = parseInt(options.expiresDays, 10);

      const created = await client.post<Invite>('/api/v1/admin/invites', body);
      if (options.json) {
        printJson(created);
      } else {
        console.log(`\nCreated invite code: ${created.code}`);
        console.log(`  ID:        ${created.id}`);
        console.log(`  Uses left: ${created.uses_left}`);
        console.log(`  Expires:   ${created.expires_at ?? 'never'}\n`);
      }
    });

  invite
    .command('remove <id>')
    .description('Delete an invite code')
    .option('--json', 'Output as JSON')
    .action(async (id: string, options, command: Command) => {
      const client = clientFromCommand(command);
      await client.del(`/api/v1/admin/invites/${encodeURIComponent(id)}`);
      if (options.json) {
        printJson({ deleted: id });
      } else {
        console.log(`Deleted invite ${id}`);
      }
    });
}

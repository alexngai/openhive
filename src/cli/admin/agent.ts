import { Command } from 'commander';
import { renderOutput, printJson, Column } from '../output.js';
import { clientFromCommand } from './_client-helper.js';

type AdminAgent = {
  id: string;
  name: string;
  is_admin?: boolean;
  verification_status?: string;
  last_seen_at?: string | null;
  created_at?: string;
};

const COLUMNS: Column<AdminAgent>[] = [
  { header: 'ID', get: (a) => a.id, max: 24 },
  { header: 'NAME', get: (a) => a.name, max: 32 },
  { header: 'STATUS', get: (a) => a.verification_status ?? '-', max: 12 },
  { header: 'ADMIN', get: (a) => (a.is_admin ? 'yes' : 'no') },
  { header: 'LAST SEEN', get: (a) => a.last_seen_at ?? '-', max: 20 },
];

export function registerAgentCommands(parent: Command, _program: Command): void {
  const agent = parent.command('agent').description('Agent management');

  agent
    .command('list')
    .description('List all agents on the hub')
    .option('--verified-only', 'Only show verified agents')
    .option('--limit <n>', 'Max results', '100')
    .option('--json', 'Output as JSON')
    .action(async (options, command: Command) => {
      const client = clientFromCommand(command);
      const result = await client.get<{ data: AdminAgent[]; total: number }>('/api/v1/admin/agents', {
        verified_only: options.verifiedOnly,
        limit: options.limit,
      });
      if (options.json) {
        printJson(result);
      } else {
        renderOutput(result.data, COLUMNS, false);
        console.log(`\n${result.data.length} of ${result.total} agents shown`);
      }
    });

  agent
    .command('verify <id>')
    .description('Verify a pending agent')
    .option('--json', 'Output as JSON')
    .action(async (id: string, options, command: Command) => {
      const client = clientFromCommand(command);
      await client.post(`/api/v1/admin/agents/${encodeURIComponent(id)}/verify`);
      if (options.json) {
        printJson({ verified: id });
      } else {
        console.log(`Verified agent ${id}`);
      }
    });

  agent
    .command('reject <id>')
    .description('Reject a pending agent verification')
    .option('--json', 'Output as JSON')
    .action(async (id: string, options, command: Command) => {
      const client = clientFromCommand(command);
      await client.post(`/api/v1/admin/agents/${encodeURIComponent(id)}/reject`);
      if (options.json) {
        printJson({ rejected: id });
      } else {
        console.log(`Rejected agent ${id}`);
      }
    });

  agent
    .command('remove <id>')
    .description('Delete an agent')
    .option('--json', 'Output as JSON')
    .action(async (id: string, options, command: Command) => {
      const client = clientFromCommand(command);
      await client.del(`/api/v1/admin/agents/${encodeURIComponent(id)}`);
      if (options.json) {
        printJson({ deleted: id });
      } else {
        console.log(`Deleted agent ${id}`);
      }
    });
}

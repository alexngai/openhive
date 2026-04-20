import { Command } from 'commander';
import { renderOutput, printJson, Column } from '../output.js';
import { clientFromCommand } from './_client-helper.js';

type Peer = {
  id: string;
  peer_endpoint: string;
  source: string;
  status: string;
  sync_group_id?: string | null;
  last_sync_at?: string | null;
};

const COLUMNS: Column<Peer>[] = [
  { header: 'ID', get: (p) => p.id, max: 24 },
  { header: 'ENDPOINT', get: (p) => p.peer_endpoint, max: 48 },
  { header: 'SOURCE', get: (p) => p.source, max: 10 },
  { header: 'STATUS', get: (p) => p.status, max: 12 },
  { header: 'GROUP', get: (p) => p.sync_group_id ?? '-', max: 24 },
  { header: 'LAST SYNC', get: (p) => p.last_sync_at ?? '-', max: 20 },
];

export function registerPeersCommands(parent: Command, _program: Command): void {
  const peers = parent.command('peers').description('Federation peer management');

  peers
    .command('list')
    .description('List configured sync peers')
    .option('--status <status>', 'Filter by status (pending/active/error/unreachable)')
    .option('--source <source>', 'Filter by source (manual/hub/gossip)')
    .option('--json', 'Output as JSON')
    .action(async (options, command: Command) => {
      const client = clientFromCommand(command);
      const result = await client.get<{ data: Peer[] }>('/api/v1/sync/peers', {
        status: options.status,
        source: options.source,
      });
      renderOutput(result.data, COLUMNS, !!options.json);
    });

  peers
    .command('add <endpoint>')
    .description('Register a sync peer')
    .option('--group <id>', 'Sync group ID (required)')
    .option('--token <token>', 'Auth token for the peer')
    .option('--json', 'Output as JSON')
    .action(async (endpoint: string, options, command: Command) => {
      if (!options.group) {
        console.error('Error: --group <sync-group-id> is required. List groups with `openhive admin peers groups` (or via the web UI).');
        process.exit(1);
      }
      const client = clientFromCommand(command);
      const body: Record<string, unknown> = {
        peer_endpoint: endpoint,
        sync_group_id: options.group,
      };
      if (options.token) body.auth_token = options.token;

      const created = await client.post<Peer>('/api/v1/sync/peers', body);
      if (options.json) {
        printJson(created);
      } else {
        console.log(`\nAdded peer:`);
        console.log(`  ID:       ${created.id}`);
        console.log(`  Endpoint: ${created.peer_endpoint}`);
        console.log(`  Status:   ${created.status}\n`);
      }
    });

  peers
    .command('remove <id>')
    .description('Remove a sync peer')
    .option('--json', 'Output as JSON')
    .action(async (id: string, options, command: Command) => {
      const client = clientFromCommand(command);
      await client.del(`/api/v1/sync/peers/${encodeURIComponent(id)}`);
      if (options.json) {
        printJson({ deleted: id });
      } else {
        console.log(`Removed peer ${id}`);
      }
    });
}

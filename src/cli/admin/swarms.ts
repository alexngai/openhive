import { Command } from 'commander';
import { renderOutput, printJson, Column } from '../output.js';
import { clientFromCommand } from './_client-helper.js';

type Swarm = {
  id: string;
  name?: string;
  status?: string;
  last_seen_at?: string | null;
  hive_id?: string | null;
  host?: string | null;
  registered_at?: string;
};

const COLUMNS: Column<Swarm>[] = [
  { header: 'ID', get: (s) => s.id, max: 24 },
  { header: 'NAME', get: (s) => s.name ?? '-', max: 24 },
  { header: 'STATUS', get: (s) => s.status ?? '-', max: 12 },
  { header: 'HIVE', get: (s) => s.hive_id ?? '-', max: 20 },
  { header: 'LAST SEEN', get: (s) => s.last_seen_at ?? '-', max: 20 },
];

export function registerSwarmsCommands(parent: Command, _program: Command): void {
  const swarms = parent.command('swarms').description('MAP swarm management');

  swarms
    .command('list')
    .description('List registered MAP swarms')
    .option('--status <status>', 'Filter by status (online/offline/unreachable)')
    .option('--limit <n>', 'Max results', '100')
    .option('--json', 'Output as JSON')
    .action(async (options, command: Command) => {
      const client = clientFromCommand(command);
      const result = await client.get<{ data: Swarm[] }>('/api/v1/map/swarms', {
        status: options.status,
        limit: options.limit,
      });
      if (options.json) {
        printJson(result);
      } else {
        renderOutput(result.data, COLUMNS, false);
      }
    });
}

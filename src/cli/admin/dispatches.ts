import { Command } from 'commander';
import { renderOutput, printJson, Column } from '../output.js';
import { clientFromCommand } from './_client-helper.js';

type Dispatch = {
  id: string;
  status: string;
  spec_id?: string | null;
  spec_resource_id?: string | null;
  target_swarm_id?: string | null;
  initiator_type?: string;
  initiator_id?: string | null;
  created_at?: string;
};

const COLUMNS: Column<Dispatch>[] = [
  { header: 'ID', get: (d) => d.id, max: 24 },
  { header: 'STATUS', get: (d) => d.status, max: 12 },
  { header: 'SPEC', get: (d) => d.spec_id ?? '-', max: 24 },
  { header: 'SWARM', get: (d) => d.target_swarm_id ?? '-', max: 24 },
  { header: 'INITIATOR', get: (d) => `${d.initiator_type ?? '?'}:${d.initiator_id ?? '-'}`, max: 32 },
  { header: 'CREATED', get: (d) => d.created_at ?? '-', max: 20 },
];

export function registerDispatchesCommands(parent: Command, _program: Command): void {
  const dispatches = parent.command('dispatches').description('Dispatch inspection and control');

  dispatches
    .command('list')
    .description('List recent dispatches')
    .option('--status <statuses>', 'Comma-separated: queued,running,complete,failed,cancelled')
    .option('--swarm <id>', 'Filter by target swarm ID')
    .option('--spec <id>', 'Filter by spec ID')
    .option('--limit <n>', 'Max results', '50')
    .option('--json', 'Output as JSON')
    .action(async (options, command: Command) => {
      const client = clientFromCommand(command);
      const result = await client.get<{ data: Dispatch[]; total: number }>('/api/v1/dispatches', {
        status: options.status,
        target_swarm_id: options.swarm,
        spec_id: options.spec,
        limit: options.limit,
      });
      if (options.json) {
        printJson(result);
      } else {
        renderOutput(result.data, COLUMNS, false);
        console.log(`\n${result.data.length} of ${result.total} dispatches shown`);
      }
    });

  dispatches
    .command('cancel <id>')
    .description('Cancel a running dispatch')
    .option('--json', 'Output as JSON')
    .action(async (id: string, options, command: Command) => {
      const client = clientFromCommand(command);
      const result = await client.post<{ dispatch: Dispatch }>(
        `/api/v1/dispatches/${encodeURIComponent(id)}/cancel`,
      );
      if (options.json) {
        printJson(result);
      } else {
        console.log(`Cancelled dispatch ${id} (status: ${result.dispatch.status})`);
      }
    });
}

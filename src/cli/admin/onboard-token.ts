import { Command } from 'commander';
import { printJson } from '../output.js';
import { clientFromCommand } from './_client-helper.js';

type OnboardTokenResult = {
  agent_id: string;
  token: string;
  method: string;
  env: Record<string, string>;
  scopes: string[];
  ttl_hours: number;
};

export function registerOnboardTokenCommands(parent: Command, _program: Command): void {
  const token = parent
    .command('onboard-token')
    .description('Mint agent-iam tokens for bootstrapping new swarms');

  token
    .command('create')
    .description(
      'Mint a delegated agent-iam token an operator can hand to a new swarm. ' +
        'Replaces the retired `admin preauth create` command.',
    )
    .option(
      '--scopes <scopes>',
      'Comma-separated agent-iam scopes (default: map:agents:spawn). ' +
        'Use map:* only for a fully-trusted coordinator.',
      'map:agents:spawn',
    )
    .option('--ttl-hours <n>', 'Token TTL in hours (default: 24, max: 720)', '24')
    .option('--agent-name <name>', 'Create a new agent with this name (auto-generated if omitted)')
    .option(
      '--agent-id <id>',
      'Re-issue a token for an existing agent id (skips agent creation)',
    )
    .option('--json', 'Output as JSON (single object with token + env)')
    .option('--env', 'Output as shell env export (ready for `eval` or sourcing)')
    .action(async (options, command: Command) => {
      const client = clientFromCommand(command);

      const scopes = String(options.scopes)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const ttlHours = parseInt(options.ttlHours, 10);

      const body: Record<string, unknown> = {
        scopes,
        ttl_hours: ttlHours,
      };
      if (options.agentName) body.agent_name = options.agentName;
      if (options.agentId) body.agent_id = options.agentId;

      const result = await client.post<OnboardTokenResult>('/api/v1/admin/onboard-token', body);

      if (options.json) {
        printJson(result);
        return;
      }

      if (options.env) {
        // Shell-sourceable output
        for (const [key, value] of Object.entries(result.env)) {
          console.log(`export ${key}=${JSON.stringify(value)}`);
        }
        return;
      }

      // Pretty default output
      console.log('');
      console.log(`Created onboarding token for ${result.agent_id}:`);
      console.log('');
      for (const [key, value] of Object.entries(result.env)) {
        console.log(`  ${key}=${value}`);
      }
      console.log('');
      console.log(`Scopes: ${result.scopes.join(', ')}`);
      console.log(`TTL:    ${result.ttl_hours}h`);
      console.log('');
      console.log('Hand the MAP_CREDENTIAL value to your swarm process — it is the');
      console.log("swarm's authentication credential for map/connect.");
      console.log('');
      console.log('Save it now: this token will not be displayed again.');
    });
}

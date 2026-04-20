import { Command } from 'commander';
import { registerAgentCommands } from './agent.js';
import { registerInviteCommands } from './invite.js';
import { registerSwarmsCommands } from './swarms.js';
import { registerConfigCommands } from './config.js';
import { registerPeersCommands } from './peers.js';
import { registerDispatchesCommands } from './dispatches.js';
import { registerOnboardTokenCommands } from './onboard-token.js';

/**
 * Register all HTTP-backed admin subcommands on the given `admin` command.
 *
 * `--server` and `--admin-key` are declared once on the `admin` parent so
 * they are truly inherited by every subcommand — e.g.
 *   openhive admin --server URL --admin-key KEY onboard-token create
 * works exactly as readers expect. Subcommand actions read them via
 * `command.optsWithGlobals()` so local overrides (`openhive admin
 * onboard-token create --server URL`) still work.
 *
 * Call from cli.ts alongside the existing DB-direct subcommands
 * (`create-key`, `create-invite`, `create-agent`) which remain unchanged for
 * back-compat.
 */
export function registerAdminHttpCommands(admin: Command, program: Command): void {
  admin
    .option('--server <url>', 'Hub URL (default: loaded from config)')
    .option('--admin-key <key>', 'Admin key (prefer HIVE_ADMIN_KEY env var; --admin-key exposes it in process args)');

  registerAgentCommands(admin, program);
  registerInviteCommands(admin, program);
  registerSwarmsCommands(admin, program);
  registerConfigCommands(admin, program);
  registerPeersCommands(admin, program);
  registerDispatchesCommands(admin, program);
  registerOnboardTokenCommands(admin, program);
}

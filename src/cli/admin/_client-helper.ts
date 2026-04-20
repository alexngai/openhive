import { Command } from 'commander';
import { createAdminClient, type AdminClient, type AdminClientOptions } from '../admin-client.js';

/**
 * Build an AdminClient from a commander Command's merged option chain.
 *
 * `optsWithGlobals()` merges subcommand-local flags with every ancestor
 * command's flags, so values set via either `openhive admin --server X
 * onboard-token create` or `openhive admin onboard-token create --server X`
 * both resolve. Local flags win when both are set (commander default).
 *
 * `dataDir` is read off the root `program` because it's the global Hive
 * flag (declared on cli.ts line ~415), not on the admin subtree.
 */
export function clientFromCommand(command: Command): AdminClient {
  const merged = command.optsWithGlobals() as Record<string, unknown>;
  // Walk up to the root to find --data-dir (declared on the root program).
  let root: Command = command;
  while (root.parent) root = root.parent;
  const rootOpts = root.opts() as Record<string, unknown>;

  const opts: AdminClientOptions = {
    server: typeof merged.server === 'string' ? merged.server : undefined,
    adminKey: typeof merged.adminKey === 'string' ? merged.adminKey : undefined,
    dataDir: typeof rootOpts.dataDir === 'string' ? rootOpts.dataDir : undefined,
  };
  return createAdminClient(opts);
}

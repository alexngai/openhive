/**
 * Prerequisite detection — binaries and environment the hub (and its
 * spawned swarms) depend on. Shared by the prereqs portion of doctor
 * output and by the swarm-hosting section (runner choices).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Config } from '../config.js';
import type { DoctorCheck } from './types.js';

const execFileAsync = promisify(execFile);

const MIN_NODE_MAJOR = 20;

/** Resolve a command on PATH. Returns the resolved path or null. */
export async function which(command: string): Promise<string | null> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(finder, [command], { timeout: 5_000 });
    const first = stdout.trim().split('\n')[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}

function check(
  name: string,
  status: DoctorCheck['status'],
  message: string,
  fix?: string,
): DoctorCheck {
  return { section: 'prereqs', name, status, message, fix };
}

async function binaryCheck(
  name: string,
  command: string,
  opts: { optional?: boolean; fix: string; why: string },
): Promise<DoctorCheck> {
  const resolved = await which(command);
  if (resolved) {
    return check(name, 'pass', `${command} found at ${resolved}`);
  }
  return check(
    name,
    opts.optional ? 'warn' : 'fail',
    `${command} not found on PATH (${opts.why})`,
    opts.fix,
  );
}

/**
 * Check that a runner command's executable resolves. `npx <pkg>` commands
 * only prove `npx` exists — the package itself resolves at first spawn,
 * so they report a warn rather than a pass.
 */
export async function runnerCommandCheck(
  label: string,
  command: string,
): Promise<DoctorCheck> {
  const head = command.trim().split(/\s+/)[0];
  if (!head) {
    return check(`runner-${label}`, 'fail', `Runner "${label}" has an empty command`);
  }
  const resolved = await which(head);
  if (!resolved) {
    return check(
      `runner-${label}`,
      'fail',
      `Runner "${label}" command "${head}" not found on PATH`,
      `Install ${head}, or point swarmHosting at a different runner (openhive setup swarm-hosting)`,
    );
  }
  if (head === 'npx') {
    const pkg = command.trim().split(/\s+/)[1] ?? '<pkg>';
    return check(
      `runner-${label}`,
      'warn',
      `Runner "${label}" uses npx — ${pkg} resolves (and may download) at first spawn`,
      `Pre-install with: npm install -g ${pkg}`,
    );
  }
  return check(`runner-${label}`, 'pass', `Runner "${label}" resolves to ${resolved}`);
}

/** All prerequisite checks for the given config. */
export async function prereqChecks(config: Config): Promise<DoctorCheck[]> {
  const results: DoctorCheck[] = [];

  const nodeMajor = parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  results.push(
    nodeMajor >= MIN_NODE_MAJOR
      ? check('node-version', 'pass', `Node ${process.versions.node}`)
      : check(
          'node-version',
          'fail',
          `Node ${process.versions.node} is below the required v${MIN_NODE_MAJOR}`,
          `Upgrade Node.js to v${MIN_NODE_MAJOR}+`,
        ),
  );

  results.push(
    await binaryCheck('git', 'git', {
      fix: 'Install git (required for the git store, repos, and git-backed resources)',
      why: 'git store, repo sync, and opentasks git-sync need it',
    }),
  );

  results.push(
    await binaryCheck('claude-cli', 'claude', {
      optional: true,
      fix: 'npm install -g @anthropic-ai/claude-code (agents spawned locally typically need it)',
      why: 'locally hosted agents usually run Claude Code',
    }),
  );

  if (config.swarmHosting.enabled) {
    results.push(
      await runnerCommandCheck('swarmkit', config.swarmHosting.swarm_runner_command),
    );
    for (const [name, command] of Object.entries(config.swarmHosting.runners ?? {})) {
      results.push(await runnerCommandCheck(name, command));
    }
  }

  const networkConfigured =
    (config as unknown as { network?: { provider?: string } }).network?.provider;
  if (networkConfigured === 'tailscale') {
    results.push(
      await binaryCheck('tailscale', 'tailscale', {
        fix: 'Install tailscale (network.provider is set to tailscale)',
        why: 'mesh networking is configured to use it',
      }),
    );
  }

  return results;
}

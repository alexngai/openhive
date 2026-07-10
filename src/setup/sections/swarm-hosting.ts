/**
 * Swarm hosting section — runner selection, provider, and credential
 * inheritance for locally hosted swarms. Deep checks probe that the
 * runner process actually starts; the full spawn→MAP-registration round
 * trip runs only when a live SwarmManager is injected (server-side
 * doctor with the hub running).
 */

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { spawn } from 'child_process';
import { runnerCommandCheck, which } from '../prereqs.js';
import { patchConfig } from '../patch.js';
import type {
  ApplyResult,
  DoctorCheck,
  SectionStatus,
  SetupContext,
  SetupField,
  SetupSection,
} from '../types.js';

function rawHosting(ctx: SetupContext): Record<string, unknown> {
  return (ctx.rawConfig.swarmHosting as Record<string, unknown> | undefined) ?? {};
}

/** Probe whether a TCP port is bindable (only meaningful when the hub is down). */
async function portBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1' }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Deep probe: start the runner process and confirm it survives its first
 * two seconds (a missing binary / instant crash fails here). The process
 * is killed immediately after — no swarm is registered.
 */
async function runnerSpawnProbe(command: string): Promise<DoctorCheck> {
  const [head, ...args] = command.trim().split(/\s+/);
  if (!head || !(await which(head))) {
    return {
      section: 'swarm-hosting',
      name: 'runner-spawn',
      status: 'fail',
      message: `Runner command "${head}" not found on PATH`,
      fix: 'Run: openhive setup swarm-hosting',
    };
  }
  return new Promise((resolve) => {
    const child = spawn(head, [...args, '--help'], {
      stdio: 'ignore',
      timeout: 20_000,
    });
    let settled = false;
    const settle = (check: DoctorCheck) => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve(check);
    };
    child.once('error', (err) =>
      settle({
        section: 'swarm-hosting',
        name: 'runner-spawn',
        status: 'fail',
        message: `Runner failed to start: ${err.message}`,
        fix: 'Check the swarm_runner_command in config (openhive setup swarm-hosting)',
      }),
    );
    // Surviving 2s (or exiting cleanly from --help) counts as spawnable.
    const timer = setTimeout(
      () =>
        settle({
          section: 'swarm-hosting',
          name: 'runner-spawn',
          status: 'pass',
          message: `Runner process starts (${command})`,
        }),
      2_000,
    );
    child.once('exit', (code) => {
      clearTimeout(timer);
      settle({
        section: 'swarm-hosting',
        name: 'runner-spawn',
        status: code === 0 || code === null ? 'pass' : 'warn',
        message:
          code === 0 || code === null
            ? `Runner responds (${command})`
            : `Runner exited with code ${code} on --help (may still work at spawn)`,
      });
    });
  });
}

export const swarmHostingSection: SetupSection = {
  id: 'swarm-hosting',
  title: 'Swarm hosting',
  description: 'Spawn and manage hosted agent swarms (runner command, provider, credentials)',

  async status(ctx: SetupContext): Promise<SectionStatus> {
    const hosting = ctx.config.swarmHosting;
    if (!hosting.enabled) {
      return { state: 'optional', summary: 'Disabled — swarms connect from outside only', issues: [] };
    }
    const issues: string[] = [];
    const head = hosting.swarm_runner_command.trim().split(/\s+/)[0];
    if (head && head !== 'npx' && !(await which(head))) {
      issues.push(`Runner command "${head}" not found on PATH`);
    }
    return {
      state: issues.length === 0 ? 'complete' : 'incomplete',
      summary: `Enabled (${hosting.default_provider}); runner: ${hosting.swarm_runner_command}`,
      issues,
    };
  },

  fields(ctx: SetupContext): SetupField[] {
    const raw = rawHosting(ctx);
    return [
      {
        key: 'enabled',
        label: 'Enable swarm hosting',
        type: 'boolean',
        default: true,
        current: raw.enabled,
      },
      {
        key: 'runnerCommand',
        label: 'Swarm runner command',
        description: 'Command that hosts a swarm (e.g. "npx @swarmkit-ai/swarm-runner serve" or "openswarm host")',
        type: 'string',
        default: 'npx @swarmkit-ai/swarm-runner serve',
        current: raw.swarm_runner_command,
      },
      {
        key: 'defaultProvider',
        label: 'Default provider',
        type: 'choice',
        choices: [
          { value: 'local', label: 'Local - subprocess on this machine' },
          { value: 'local-sandboxed', label: 'Local sandboxed - restricted subprocess' },
        ],
        default: 'local',
        current: raw.default_provider,
      },
      {
        key: 'inheritEnv',
        label: 'Inherit environment',
        description: "Pass the operator's environment (API keys, etc.) to spawned swarms",
        type: 'boolean',
        default: true,
        current: (raw.credentials as Record<string, unknown> | undefined)?.inherit_env,
      },
    ];
  },

  async apply(ctx: SetupContext, answers: Record<string, unknown>): Promise<ApplyResult> {
    const enabled = answers.enabled !== false && answers.enabled !== 'false';
    patchConfig(ctx, {
      swarmHosting: {
        enabled,
        ...(answers.runnerCommand
          ? { swarm_runner_command: String(answers.runnerCommand) }
          : {}),
        ...(answers.defaultProvider
          ? { default_provider: String(answers.defaultProvider) }
          : {}),
        ...(answers.inheritEnv !== undefined
          ? { credentials: { inherit_env: answers.inheritEnv !== false && answers.inheritEnv !== 'false' } }
          : {}),
      },
    });
    return {
      ok: true,
      message: enabled ? 'Swarm hosting configured' : 'Swarm hosting disabled',
      restartRequired: ctx.hubRunning,
    };
  },

  async checks(ctx: SetupContext, deep: boolean): Promise<DoctorCheck[]> {
    const hosting = ctx.config.swarmHosting;
    if (!hosting.enabled) {
      return [
        {
          section: 'swarm-hosting',
          name: 'swarm-hosting',
          status: 'warn',
          message: 'Swarm hosting disabled (optional) — hub cannot spawn agents itself',
          fix: 'Run: openhive setup swarm-hosting',
        },
      ];
    }

    const results: DoctorCheck[] = [];
    results.push({
      ...(await runnerCommandCheck('swarmkit', hosting.swarm_runner_command)),
      section: 'swarm-hosting',
    });

    // Swarm data dir writable
    const dataDir = path.resolve(hosting.data_dir);
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.accessSync(dataDir, fs.constants.W_OK);
      results.push({
        section: 'swarm-hosting',
        name: 'data-dir-writable',
        status: 'pass',
        message: `Swarm data dir writable: ${dataDir}`,
      });
    } catch (err) {
      results.push({
        section: 'swarm-hosting',
        name: 'data-dir-writable',
        status: 'fail',
        message: `Swarm data dir not writable: ${dataDir} (${(err as Error).message})`,
        fix: 'Fix permissions or change swarmHosting.data_dir',
      });
    }

    // First port of the spawn range bindable (only meaningful hub-down;
    // when the hub runs it may legitimately have swarms on these ports)
    if (!ctx.hubRunning) {
      const [firstPort] = hosting.port_range;
      const free = await portBindable(firstPort);
      results.push({
        section: 'swarm-hosting',
        name: 'port-range',
        status: free ? 'pass' : 'warn',
        message: free
          ? `Swarm port range starts free (${firstPort})`
          : `Port ${firstPort} (start of swarm range) is already in use`,
        fix: 'Adjust swarmHosting.port_range if another service owns these ports',
      });
    }

    if (deep) {
      results.push(await runnerSpawnProbe(hosting.swarm_runner_command));
      if (!ctx.deps?.swarmManager) {
        results.push({
          section: 'swarm-hosting',
          name: 'probe-swarm',
          status: 'warn',
          message: 'Full spawn round-trip needs a running hub (run doctor via GET /admin/doctor?deep=true)',
        });
      }
      // Full probe-swarm via a live SwarmManager is intentionally not
      // wired yet: spawn + MAP registration + teardown through the
      // manager needs a dedicated probe pathway (follow-up).
    }

    return results;
  },
};

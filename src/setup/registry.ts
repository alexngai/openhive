/**
 * Setup registry — the ordered section list plus the runners the three
 * consumers share (CLI in-process, /admin/setup routes, web onboarding).
 */

import * as fs from 'fs';
import * as net from 'net';
import { dataDirPaths } from '../data-dir.js';
import { readConfigFile } from '../config-persistence.js';
import {
  ConfigSchema,
  applyGitStoreDerivations,
  defaultConfig,
  type Config,
} from '../config.js';
import { prereqChecks } from './prereqs.js';
import { coreSection } from './sections/core.js';
import { gitStoreSection } from './sections/git-store.js';
import { swarmHostingSection } from './sections/swarm-hosting.js';
import { agentAccessSection } from './sections/agent-access.js';
import { servicesSection } from './sections/services.js';
import type { DoctorCheck, SetupContext, SetupSection } from './types.js';

export const SECTIONS: SetupSection[] = [
  coreSection,
  gitStoreSection,
  swarmHostingSection,
  agentAccessSection,
  servicesSection,
];

export function getSection(id: string): SetupSection | undefined {
  return SECTIONS.find((s) => s.id === id);
}

/** Probe the configured port for a live hub (short timeout). */
async function probeHub(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/openhive.json`, {
      signal: AbortSignal.timeout(1_500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Build a SetupContext from a data directory. Reads the config file
 * directly (env overrides deliberately excluded — setup edits the file,
 * which is the source of truth it can affect).
 */
export async function buildSetupContext(
  dataDir: string,
  deps?: SetupContext['deps'],
): Promise<SetupContext> {
  const configPath = dataDirPaths(dataDir).config;
  const rawConfig = readConfigFile(configPath);

  let config: Config = defaultConfig;
  let configParseError: string | null = null;
  try {
    const raw = JSON.parse(JSON.stringify(rawConfig)) as Record<string, unknown>;
    applyGitStoreDerivations(raw);
    config = ConfigSchema.parse(raw);
  } catch (err) {
    configParseError = (err as Error).message.split('\n')[0] ?? 'invalid config';
  }

  const hubRunning = await probeHub(config.port);
  return { dataDir, configPath, rawConfig, config, configParseError, hubRunning, deps };
}

/** Refresh the parsed view after an apply mutated the config file. */
export async function refreshContext(ctx: SetupContext): Promise<SetupContext> {
  const next = await buildSetupContext(ctx.dataDir, ctx.deps);
  Object.assign(ctx, next);
  return ctx;
}

export interface SectionReport {
  id: string;
  title: string;
  description: string;
  status: Awaited<ReturnType<SetupSection['status']>>;
  fields: ReturnType<SetupSection['fields']>;
}

export async function statusAll(ctx: SetupContext): Promise<SectionReport[]> {
  const reports: SectionReport[] = [];
  for (const section of SECTIONS) {
    reports.push({
      id: section.id,
      title: section.title,
      description: section.description,
      status: await section.status(ctx),
      fields: section.fields(ctx),
    });
  }
  return reports;
}

async function portFreeCheck(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1' }, () => server.close(() => resolve(true)));
  });
}

/** Global cheap checks that don't belong to any one section. */
async function globalChecks(ctx: SetupContext): Promise<DoctorCheck[]> {
  const results: DoctorCheck[] = [];

  if (ctx.hubRunning) {
    results.push({
      section: 'hub',
      name: 'hub-reachable',
      status: 'pass',
      message: `Hub responding on port ${ctx.config.port} (/.well-known/openhive.json)`,
    });
  } else {
    const free = await portFreeCheck(ctx.config.port);
    results.push({
      section: 'hub',
      name: 'port-available',
      status: free ? 'pass' : 'fail',
      message: free
        ? `Hub not running; port ${ctx.config.port} is free`
        : `Port ${ctx.config.port} is occupied by something that is not an OpenHive hub`,
      fix: 'Stop the conflicting process or change the port (openhive setup core)',
    });
  }

  // Task-graph store writability (hub/default lives in the git store when
  // enabled, else under <dataDir>/task-graph)
  const storeDir = ctx.config.gitStore.enabled
    ? ctx.config.gitStore.path
    : undefined;
  const taskGraphParent = storeDir ?? ctx.dataDir;
  try {
    fs.accessSync(taskGraphParent, fs.constants.W_OK);
    results.push({
      section: 'hub',
      name: 'task-graph-writable',
      status: 'pass',
      message: `Task graph location writable (${taskGraphParent})`,
    });
  } catch {
    results.push({
      section: 'hub',
      name: 'task-graph-writable',
      status: fs.existsSync(taskGraphParent) ? 'fail' : 'warn',
      message: `Task graph location not writable: ${taskGraphParent}`,
      fix: 'Check permissions (specs cannot be written otherwise)',
    });
  }

  return results;
}

/**
 * Run the doctor: prereqs + global checks + every section's checks.
 * `deep` adds network/spawn probes (git remote reachability, runner
 * process start, ...).
 */
export async function runDoctor(
  ctx: SetupContext,
  opts: { deep?: boolean } = {},
): Promise<DoctorCheck[]> {
  const deep = opts.deep ?? false;
  const results: DoctorCheck[] = [];
  results.push(...(await prereqChecks(ctx.config)));
  results.push(...(await globalChecks(ctx)));
  for (const section of SECTIONS) {
    try {
      results.push(...(await section.checks(ctx, deep)));
    } catch (err) {
      results.push({
        section: section.id,
        name: `${section.id}-checks`,
        status: 'fail',
        message: `Checks crashed: ${(err as Error).message}`,
      });
    }
  }
  return results;
}

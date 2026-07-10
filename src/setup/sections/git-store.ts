/**
 * Git store section — the unified git repo for git-backed hive state
 * (see src/git-store.ts). Apply patches `gitStore` and initialises the
 * repo immediately so it exists before the first hub boot.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ConfigSchema, applyGitStoreDerivations } from '../../config.js';
import { ensureGitStore, resolveGitStorePath } from '../../git-store.js';
import { patchConfig } from '../patch.js';
import type {
  ApplyResult,
  DoctorCheck,
  SectionStatus,
  SetupContext,
  SetupField,
  SetupSection,
} from '../types.js';

const execFileAsync = promisify(execFile);

function rawGitStore(ctx: SetupContext): Record<string, unknown> {
  return (ctx.rawConfig.gitStore as Record<string, unknown> | undefined) ?? {};
}

export const gitStoreSection: SetupSection = {
  id: 'git-store',
  title: 'Git store',
  description:
    'Single git repo holding git-backed hive state (task graph, sessions, memory, skills)',

  async status(ctx: SetupContext): Promise<SectionStatus> {
    if (!ctx.config.gitStore.enabled) {
      return {
        state: 'optional',
        summary: 'Disabled — git-backed features use their individual default paths',
        issues: [],
      };
    }
    const storePath = resolveGitStorePath(ctx.config);
    const issues: string[] = [];
    if (!fs.existsSync(path.join(storePath, '.git'))) {
      issues.push(`Store at ${storePath} is not a git repository yet`);
    }
    return {
      state: issues.length === 0 ? 'complete' : 'incomplete',
      summary: `Enabled at ${storePath}${ctx.config.gitStore.remote ? ` → ${ctx.config.gitStore.remote}` : ' (local-only)'}`,
      issues,
    };
  },

  fields(ctx: SetupContext): SetupField[] {
    const raw = rawGitStore(ctx);
    return [
      {
        key: 'enabled',
        label: 'Enable git store',
        type: 'boolean',
        default: false,
        current: raw.enabled,
      },
      {
        key: 'path',
        label: 'Store path',
        description: 'Default: <dataDir>/hive-store',
        type: 'string',
        default: path.join(ctx.dataDir, 'hive-store'),
        current: raw.path,
        optional: true,
      },
      {
        key: 'remote',
        label: 'Remote URL',
        description: 'Optional push target — leave empty for a local-only repo',
        type: 'string',
        current: raw.remote,
        optional: true,
      },
    ];
  },

  async apply(ctx: SetupContext, answers: Record<string, unknown>): Promise<ApplyResult> {
    const enabled = answers.enabled === true || answers.enabled === 'true';
    if (!enabled) {
      patchConfig(ctx, { gitStore: { enabled: false } });
      return { ok: true, message: 'Git store disabled' };
    }

    const storePath = (answers.path as string | undefined)?.trim() || path.join(ctx.dataDir, 'hive-store');
    const remote = (answers.remote as string | undefined)?.trim() || undefined;

    patchConfig(ctx, {
      gitStore: {
        enabled: true,
        path: storePath,
        ...(remote ? { remote } : {}),
      },
    });

    // Initialise the repo now so it exists before the first boot. Parse a
    // config view with derivations applied, same as loadConfig would.
    const raw = JSON.parse(JSON.stringify(ctx.rawConfig)) as Record<string, unknown>;
    applyGitStoreDerivations(raw);
    const parsed = ConfigSchema.parse(raw);
    const resolved = await ensureGitStore(parsed);

    return {
      ok: true,
      message: `Git store initialised at ${resolved}`,
      restartRequired: ctx.hubRunning,
      outputs: { path: resolved },
    };
  },

  async checks(ctx: SetupContext, deep: boolean): Promise<DoctorCheck[]> {
    if (!ctx.config.gitStore.enabled) {
      return [
        {
          section: 'git-store',
          name: 'git-store',
          status: 'warn',
          message: 'Git store disabled (optional) — enable to keep hive state in one repo',
          fix: 'Run: openhive setup git-store',
        },
      ];
    }

    const results: DoctorCheck[] = [];
    const storePath = resolveGitStorePath(ctx.config);
    const isRepo = fs.existsSync(path.join(storePath, '.git'));
    results.push({
      section: 'git-store',
      name: 'store-repo',
      status: isRepo ? 'pass' : 'fail',
      message: isRepo
        ? `Store repo at ${storePath}`
        : `Store at ${storePath} is not a git repository`,
      fix: 'Run: openhive setup git-store (re-initialises the repo)',
    });

    const remote = ctx.config.gitStore.remote;
    if (deep && isRepo && remote) {
      try {
        await execFileAsync('git', ['ls-remote', '--heads', remote], {
          cwd: storePath,
          timeout: 15_000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        results.push({
          section: 'git-store',
          name: 'remote-reachable',
          status: 'pass',
          message: `Remote reachable: ${remote}`,
        });
      } catch (err) {
        results.push({
          section: 'git-store',
          name: 'remote-reachable',
          status: 'warn',
          message: `Remote unreachable: ${remote} (${(err as Error).message.split('\n')[0]})`,
          fix: 'Check the URL and your credentials/SSH agent',
        });
      }
    }

    return results;
  },
};

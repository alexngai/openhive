/**
 * Core section — hub identity. Covers exactly what the original
 * `runSetupWizard` configured: instance name, port, auth mode, hub mode,
 * MAP trust model, admin key, plus data-dir/database initialization.
 */

import * as fs from 'fs';
import { nanoid } from 'nanoid';
import { ensureDataDir, dataDirPaths, isInitialised } from '../../data-dir.js';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { patchConfig } from '../patch.js';
import type {
  ApplyResult,
  DoctorCheck,
  SectionStatus,
  SetupContext,
  SetupField,
  SetupSection,
} from '../types.js';

export const coreSection: SetupSection = {
  id: 'core',
  title: 'Core hub',
  description: 'Instance identity, port, auth mode, and MAP trust model',

  async status(ctx: SetupContext): Promise<SectionStatus> {
    const paths = dataDirPaths(ctx.dataDir);
    const issues: string[] = [];
    if (!isInitialised(ctx.dataDir)) issues.push('Data directory not initialised');
    if (!fs.existsSync(ctx.configPath)) issues.push('Config file missing');
    if (!fs.existsSync(paths.database)) issues.push('Database not created');
    if (ctx.configParseError) issues.push(`Config invalid: ${ctx.configParseError}`);
    if (!(ctx.rawConfig.admin as Record<string, unknown> | undefined)?.key) {
      issues.push('No admin key configured');
    }

    return {
      state: issues.length === 0 ? 'complete' : 'incomplete',
      summary:
        issues.length === 0
          ? `${ctx.config.instance.name} on port ${ctx.config.port} (auth: ${ctx.config.auth.mode}, trust: ${ctx.config.mapHub.trustModel ?? 'unset'})`
          : 'Hub not fully initialised',
      issues,
    };
  },

  fields(ctx: SetupContext): SetupField[] {
    return [
      {
        key: 'name',
        label: 'Instance name',
        type: 'string',
        default: 'OpenHive',
        current: (ctx.rawConfig.instance as Record<string, unknown> | undefined)?.name,
      },
      {
        key: 'port',
        label: 'Port',
        type: 'number',
        default: 7836,
        current: ctx.rawConfig.port,
      },
      {
        key: 'trustModel',
        label: 'Agent trust model',
        description: 'How agents authenticate over the MAP WebSocket',
        type: 'choice',
        choices: [
          { value: 'verified', label: 'Verified - agents must present an operator-issued token (recommended)' },
          { value: 'open', label: 'Open - any agent connects with an API key (localhost / single-operator only)' },
        ],
        default: 'verified',
        current: (ctx.rawConfig.mapHub as Record<string, unknown> | undefined)?.trustModel,
      },
      {
        key: 'authMode',
        label: 'Auth mode',
        type: 'choice',
        choices: [
          { value: 'local', label: 'Local - no login required, single-user (default)' },
          { value: 'token', label: 'Token - email/password registration and API keys' },
        ],
        default: 'local',
        current: (ctx.rawConfig.auth as Record<string, unknown> | undefined)?.mode,
      },
      {
        key: 'hubMode',
        label: 'Hub mode',
        type: 'choice',
        choices: [
          { value: 'full', label: 'Full - web UI + API (default, for human-facing deployments)' },
          { value: 'server', label: 'Server - headless, agents-only (manage via `openhive admin` CLI)' },
        ],
        default: 'full',
        current: ctx.rawConfig.mode,
      },
      {
        key: 'trustLocalMode',
        label: 'Trust local mode',
        description: 'Admin routes accept NO credentials — only safe on localhost/trusted networks',
        type: 'boolean',
        default: false,
        optional: true,
        current: (ctx.rawConfig.admin as Record<string, unknown> | undefined)?.trustLocalMode,
      },
    ];
  },

  async apply(ctx: SetupContext, answers: Record<string, unknown>): Promise<ApplyResult> {
    const paths = dataDirPaths(ctx.dataDir);
    ensureDataDir(ctx.dataDir);

    const existingAdmin = ctx.rawConfig.admin as Record<string, unknown> | undefined;
    const adminKey =
      (answers.adminKey as string | undefined) ??
      (existingAdmin?.key as string | undefined) ??
      nanoid(32);
    const generatedKey = !existingAdmin?.key;

    const port = Number(answers.port ?? ctx.rawConfig.port ?? 7836) || 7836;
    patchConfig(ctx, {
      port,
      host: (ctx.rawConfig.host as string | undefined) ?? '127.0.0.1',
      mode: (answers.hubMode as string | undefined) ?? ctx.rawConfig.mode ?? 'full',
      database: (ctx.rawConfig.database as string | undefined) ?? paths.database,
      instance: {
        name: (answers.name as string | undefined) ?? 'OpenHive',
        description:
          ((ctx.rawConfig.instance as Record<string, unknown> | undefined)
            ?.description as string | undefined) ?? 'Agent swarm coordination hub',
        public: true,
      },
      admin: {
        key: adminKey,
        ...(answers.trustLocalMode === true ? { trustLocalMode: true } : {}),
      },
      auth: { mode: (answers.authMode as string | undefined) ?? 'local' },
      mapHub: { trustModel: (answers.trustModel as string | undefined) ?? 'verified' },
      storage: (ctx.rawConfig.storage as Record<string, unknown> | undefined) ?? {
        type: 'local',
        path: paths.uploads,
        publicUrl: '/uploads',
      },
      federation:
        (ctx.rawConfig.federation as Record<string, unknown> | undefined) ?? {
          enabled: false,
          peers: [],
        },
    });

    // Initialise the database so the hub is ready immediately. Skip when
    // the hub is running (it owns the DB) or the file already exists.
    if (!ctx.hubRunning && !fs.existsSync(paths.database)) {
      initDatabase(paths.database);
      closeDatabase();
    }

    return {
      ok: true,
      message: `Core hub configured (port ${port})`,
      restartRequired: ctx.hubRunning,
      outputs: generatedKey ? { adminKey } : {},
    };
  },

  async checks(ctx: SetupContext): Promise<DoctorCheck[]> {
    const paths = dataDirPaths(ctx.dataDir);
    const results: DoctorCheck[] = [];
    const push = (name: string, ok: boolean, msg: string, fix?: string) =>
      results.push({
        section: 'core',
        name,
        status: ok ? 'pass' : 'fail',
        message: msg,
        fix,
      });

    push(
      'data-dir',
      isInitialised(ctx.dataDir),
      isInitialised(ctx.dataDir)
        ? `Data directory initialised at ${ctx.dataDir}`
        : `Data directory not initialised at ${ctx.dataDir}`,
      'Run: openhive setup core',
    );
    push(
      'config-file',
      fs.existsSync(ctx.configPath),
      fs.existsSync(ctx.configPath) ? `Config at ${ctx.configPath}` : 'Config file missing',
      'Run: openhive setup core',
    );
    if (ctx.configParseError) {
      results.push({
        section: 'core',
        name: 'config-valid',
        status: 'fail',
        message: `Config does not validate: ${ctx.configParseError}`,
        fix: 'Fix the reported key in config.json (or re-run: openhive setup)',
      });
    } else {
      push('config-valid', true, 'Config validates against the schema');
    }
    push(
      'database',
      fs.existsSync(paths.database),
      fs.existsSync(paths.database)
        ? `Database at ${paths.database}`
        : 'Database not created',
      'Run: openhive setup core',
    );

    return results;
  },
};

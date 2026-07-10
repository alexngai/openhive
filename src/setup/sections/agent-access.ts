/**
 * Agent access section — how agents get onto this hub. Under the
 * `verified` trust model, apply mints an onboard token (shared logic
 * with POST /admin/onboard-token) and returns copy-paste connect
 * snippets. Under `open` trust the section is informational.
 */

import * as fs from 'fs';
import { dataDirPaths } from '../../data-dir.js';
import { getDatabase, initDatabase } from '../../db/index.js';
import {
  initTokenService,
  isTokenServiceInitialized,
} from '../../map/token-service.js';
import { mintOnboardToken } from '../../map/onboard.js';
import * as agentsDAL from '../../db/dal/agents.js';
import type {
  ApplyResult,
  DoctorCheck,
  SectionStatus,
  SetupContext,
  SetupField,
  SetupSection,
} from '../types.js';

/**
 * Make sure the DB and token service are usable. In-server both are
 * already initialised; from the CLI this opens the data-dir database
 * (the CLI driver closes it when done).
 */
function ensureServices(ctx: SetupContext): void {
  try {
    getDatabase();
  } catch {
    initDatabase(dataDirPaths(ctx.dataDir).database);
  }
  if (!isTokenServiceInitialized()) {
    initTokenService(ctx.config.mapHub.iamSecret, ctx.dataDir);
  }
}

function connectSnippets(token: string, port: number): string[] {
  const url = `ws://127.0.0.1:${port}/ws`;
  return [
    `# swarm-runner / swarmkit:\nOPENHIVE_URL=${url} MAP_AGENT_TOKEN=${token} npx @swarmkit-ai/swarm-runner serve`,
    `# openswarm:\nOPENHIVE_URL=${url} MAP_AGENT_TOKEN=${token} openswarm host`,
  ];
}

export const agentAccessSection: SetupSection = {
  id: 'agent-access',
  title: 'Agent access',
  description: 'Trust model recap and onboard-token minting for the first agents',

  async status(ctx: SetupContext): Promise<SectionStatus> {
    const trust = ctx.config.mapHub.trustModel;
    if (trust === 'open') {
      return {
        state: 'optional',
        summary: 'Open trust — agents connect with an API key, no tokens needed',
        issues: [],
      };
    }
    return {
      state: 'optional',
      summary: `Verified trust — agents need an operator-issued token (mint one here or via \`openhive admin onboard-token create\`)`,
      issues: [],
    };
  },

  fields(ctx: SetupContext): SetupField[] {
    if (ctx.config.mapHub.trustModel === 'open') return [];
    return [
      {
        key: 'mintToken',
        label: 'Mint an onboard token now',
        type: 'boolean',
        default: true,
      },
      {
        key: 'agentName',
        label: 'Agent name',
        type: 'string',
        default: 'first-agent',
        optional: true,
      },
      {
        key: 'scopes',
        label: 'Token scopes (comma-separated)',
        type: 'string',
        default: 'map:agents:spawn',
        optional: true,
      },
      {
        key: 'ttlHours',
        label: 'Token TTL (hours)',
        type: 'number',
        default: 24,
        optional: true,
      },
    ];
  },

  async apply(ctx: SetupContext, answers: Record<string, unknown>): Promise<ApplyResult> {
    if (ctx.config.mapHub.trustModel === 'open' || answers.mintToken === false || answers.mintToken === 'false') {
      return { ok: true, message: 'No token minted' };
    }

    ensureServices(ctx);
    const scopes = String(answers.scopes ?? 'map:agents:spawn')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const minted = await mintOnboardToken({
      scopes,
      ttlHours: Number(answers.ttlHours ?? 24) || 24,
      agentName: (answers.agentName as string | undefined) || 'first-agent',
    });

    return {
      ok: true,
      message: `Token minted for agent ${minted.agent_id} (expires ${minted.expires_at})`,
      outputs: {
        token: minted.token,
        agent_id: minted.agent_id,
        expires_at: minted.expires_at,
        snippets: connectSnippets(minted.token, ctx.config.port),
      },
    };
  },

  async checks(ctx: SetupContext): Promise<DoctorCheck[]> {
    const results: DoctorCheck[] = [];
    const trust = ctx.config.mapHub.trustModel;
    results.push({
      section: 'agent-access',
      name: 'trust-model',
      status: trust ? 'pass' : 'warn',
      message: trust
        ? `Trust model: ${trust}`
        : 'Trust model unset — a fresh hub defaults to verified, an existing one is grandfathered to open',
      fix: 'Run: openhive setup core',
    });

    // Agent count is informational; needs an initialised database.
    const dbPath = dataDirPaths(ctx.dataDir).database;
    if (fs.existsSync(dbPath)) {
      try {
        try {
          getDatabase();
        } catch {
          initDatabase(dbPath);
        }
        const count = agentsDAL.countAgents();
        results.push({
          section: 'agent-access',
          name: 'agents',
          status: count > 0 ? 'pass' : 'warn',
          message: count > 0 ? `${count} agent(s) registered` : 'No agents registered yet',
          fix: 'Mint a token (openhive setup agent-access) and connect your first agent',
        });
      } catch (err) {
        results.push({
          section: 'agent-access',
          name: 'agents',
          status: 'warn',
          message: `Could not query agents: ${(err as Error).message}`,
        });
      }
    }

    return results;
  },
};

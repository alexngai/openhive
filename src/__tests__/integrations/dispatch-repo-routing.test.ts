/**
 * Dispatch repo-routing integration: repo metadata from dispatch row
 * survives the full enrichment → side-channel → mail-port envelope path.
 *
 * Covers the Phase 3 repo-coordination flow:
 *
 *   dispatch row (repo_id, branch, clone_policy, …)
 *     → enrichWithRepo surfaces fields onto task.metadata
 *     → registerRepoForDispatch stores full binding in side-channel
 *     → mail port injectRepoMetadata reads side-channel → body.metadata
 *     → consumer reads body.metadata.repo_id, canonical_url, clone_policy, …
 *
 * Approach: "direct adapter drive" — real DB + real enrichment + stub transport.
 * No subprocess, no orchestrator polling, no network.
 *
 * Run:
 *   npx vitest run src/__tests__/integrations/dispatch-repo-routing.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as dispatchesDAL from '../../db/dal/dispatches.js';
import * as reposDAL from '../../db/dal/repos.js';
import {
  createOpenHiveDispatchSource,
  type SpecContentFetcher,
} from '../../dispatch/openhive-source.js';
import { createOpenHiveMailPort, type MailTransport } from '../../dispatch/openhive-mail-port.js';
import {
  getRepoBindingForDispatch,
  _resetRepoSideChannelForTest,
} from '../../dispatch/repo-side-channel.js';
import {
  registerInbound,
  unregisterInbound,
  type MapInboundConnection,
  type RegisteredAgent,
} from '../../map/connection-registry.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import { canonicalizeRepoUrl } from 'agent-workspace/kinds/repo';

// ============================================================================
// Constants
// ============================================================================

const TEST_ROOT = testRoot('dispatch-repo-routing');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'repo-routing.db');

// Canonical form (no `.git` suffix) — `canonicalizeRepoUrl` strips it, and the
// repo row + downstream envelope metadata stores the canonical form.
const REPO_CANONICAL_URL = 'https://github.com/test-org/test-repo';
const MAIL_SWARM_ID = 'repo-test-swarm-001';
const MAIL_AGENT_ID = 'repo-test-agent-001';

// ============================================================================
// Fixture helpers
// ============================================================================

function makeSpecFetcher(): SpecContentFetcher {
  return {
    async fetch(_resourceId, specId) {
      return {
        title: `Repo Spec ${specId}`,
        content: 'Work on the repo.',
        tasks: [],
        metadata: {},
      };
    },
  };
}

interface RecordedSend {
  swarmId: string;
  agentId: string;
  message: { type: string; body: Record<string, unknown> };
}

function createRecordingTransport(): MailTransport & { recorded: RecordedSend[] } {
  const recorded: RecordedSend[] = [];
  return {
    recorded,
    async sendToAgent(swarmId, agentId, message) {
      recorded.push({ swarmId, agentId, message });
      return { delivered: true };
    },
    onMessage(_handler) {
      return () => {};
    },
  };
}

function createMockWs(): WebSocket {
  const ee = new EventEmitter() as unknown as WebSocket;
  (ee as unknown as Record<string, unknown>).readyState = 1;
  (ee as unknown as Record<string, unknown>).send = () => {};
  (ee as unknown as Record<string, unknown>).close = () => {};
  (ee as unknown as Record<string, unknown>).terminate = () => {};
  return ee;
}

function registerMailSwarm(): void {
  const agent: RegisteredAgent = {
    id: MAIL_AGENT_ID,
    name: 'repo-worker',
    role: 'worker',
    state: 'idle',
    scopes: [],
    capabilities: {
      mail: { canJoin: true },
      messaging: { canReceive: true },
    },
  };

  const conn: MapInboundConnection = {
    ws: createMockWs(),
    agentId: MAIL_AGENT_ID,
    swarmId: MAIL_SWARM_ID,
    connectedAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    registeredAgents: new Map([[MAIL_AGENT_ID, agent]]),
  };

  registerInbound(MAIL_SWARM_ID, conn);
}

// ============================================================================
// Tests
// ============================================================================

describe('dispatch repo-routing integration', () => {
  let agentId: string;
  let claimantId: string;
  let repoId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({ name: 'repo-routing-test-agent' });
    agentId = agent.id;
    claimantId = `orchestrator-${agent.id}`;
    registerMailSwarm();

    // Create a repo row so enrichWithRepo can resolve canonical_url.
    const repo = reposDAL.upsertRepoByCanonicalUrl(
      canonicalizeRepoUrl(REPO_CANONICAL_URL),
      { name: 'test-repo', origin: 'user_defined', owner_agent_id: agentId },
    );
    repoId = repo.id;
  });

  afterAll(() => {
    try { unregisterInbound(MAIL_SWARM_ID); } catch { /* best effort */ }
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    _resetRepoSideChannelForTest();
    const db = getDatabase();
    db.prepare('DELETE FROM dispatches').run();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Core: repo fields on dispatch row survive enrichment → mail envelope
  // ─────────────────────────────────────────────────────────────────────

  it('repo metadata from dispatch row reaches the mail envelope body.metadata', async () => {
    const dispatch = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_repo_spec',
      spec_id: 'repo-001',
      target_swarm_id: MAIL_SWARM_ID,
      initiator_type: 'user',
      initiator_id: agentId,
      repo_id: repoId,
      branch: 'feature/agent-work',
      commit_sha: 'deadbeef1234',
      clone_policy: 'allowed',
      clone_path: '/workspace/repos/test-repo',
    });

    // Source enriches via spec fetch + repo enrichment.
    const source = createOpenHiveDispatchSource(makeSpecFetcher(), claimantId);
    const ready = await source.queryReady({ limit: 10 });
    const enriched = ready.find((t) => t.id === dispatch.id);
    expect(enriched).toBeTruthy();

    // Verify enrichment surfaced repo fields onto task.metadata.
    expect(enriched!.metadata?.repo_id).toBe(repoId);
    expect(enriched!.metadata?.branch).toBe('feature/agent-work');
    expect(enriched!.metadata?.commit_sha).toBe('deadbeef1234');
    expect(enriched!.metadata?.clone_policy).toBe('allowed');
    expect(enriched!.metadata?.clone_path).toBe('/workspace/repos/test-repo');

    // Verify the repo side-channel has the full binding.
    const binding = getRepoBindingForDispatch(dispatch.id);
    expect(binding).toBeTruthy();
    expect(binding!.repoId).toBe(repoId);
    expect(binding!.branch).toBe('feature/agent-work');
    expect(binding!.commitSha).toBe('deadbeef1234');
    expect(binding!.clonePolicy).toBe('allowed');
    expect(binding!.clonePath).toBe('/workspace/repos/test-repo');

    // Drive the mail port — the side-channel should inject repo metadata.
    const transport = createRecordingTransport();
    const mailPort = createOpenHiveMailPort(transport);

    const receipt = await mailPort.deliver(
      { system: MAIL_SWARM_ID, agentId: MAIL_AGENT_ID },
      { prompt: 'Do the work', taskId: dispatch.id, role: 'worker' },
    );

    expect(receipt.delivered).toBe(true);
    expect(transport.recorded).toHaveLength(1);

    const body = transport.recorded[0].message.body as Record<string, unknown>;
    expect(body.taskId).toBe(dispatch.id);

    // The metadata block must carry all repo fields.
    const meta = body.metadata as Record<string, unknown>;
    expect(meta.repo_id).toBe(repoId);
    expect(meta.canonical_url).toBe(REPO_CANONICAL_URL);
    expect(meta.branch).toBe('feature/agent-work');
    expect(meta.commit_sha).toBe('deadbeef1234');
    expect(meta.clone_policy).toBe('allowed');
    expect(meta.clone_path).toBe('/workspace/repos/test-repo');
  });

  // ─────────────────────────────────────────────────────────────────────
  // canonical_url resolution from repo row
  // ─────────────────────────────────────────────────────────────────────

  it('resolves canonical_url from repo row when not on dispatch and injects it into envelope', async () => {
    const dispatch = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_repo_spec',
      spec_id: 'repo-002',
      target_swarm_id: MAIL_SWARM_ID,
      initiator_type: 'user',
      initiator_id: agentId,
      repo_id: repoId,
      // No canonical_url, branch, commit_sha, clone_policy
    });

    const source = createOpenHiveDispatchSource(makeSpecFetcher(), claimantId);
    const ready = await source.queryReady({ limit: 10 });
    const enriched = ready.find((t) => t.id === dispatch.id);

    // canonical_url should be resolved from the repo row.
    expect(enriched!.metadata?.canonical_url).toBe(REPO_CANONICAL_URL);

    // Side-channel should have it too.
    const binding = getRepoBindingForDispatch(dispatch.id);
    expect(binding!.repoId).toBe(repoId);

    // Mail envelope should carry the resolved canonical_url.
    const transport = createRecordingTransport();
    const mailPort = createOpenHiveMailPort(transport);
    await mailPort.deliver(
      { system: MAIL_SWARM_ID, agentId: MAIL_AGENT_ID },
      { prompt: 'work', taskId: dispatch.id, role: 'worker' },
    );

    const meta = transport.recorded[0].message.body.metadata as Record<string, unknown>;
    expect(meta.repo_id).toBe(repoId);
    expect(meta.canonical_url).toBe(REPO_CANONICAL_URL);
  });

  // ─────────────────────────────────────────────────────────────────────
  // No repo_id → no repo metadata in envelope
  // ─────────────────────────────────────────────────────────────────────

  it('envelope has no repo metadata when dispatch has no repo_id', async () => {
    const dispatch = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_no_repo',
      spec_id: 'no-repo-001',
      target_swarm_id: MAIL_SWARM_ID,
      initiator_type: 'user',
      initiator_id: agentId,
      // No repo fields
    });

    const source = createOpenHiveDispatchSource(makeSpecFetcher(), claimantId);
    const ready = await source.queryReady({ limit: 10 });
    const enriched = ready.find((t) => t.id === dispatch.id);

    expect(enriched!.metadata?.repo_id).toBeUndefined();

    // Side-channel should have no entry.
    expect(getRepoBindingForDispatch(dispatch.id)).toBeUndefined();

    // Mail envelope should not have repo metadata.
    const transport = createRecordingTransport();
    const mailPort = createOpenHiveMailPort(transport);
    await mailPort.deliver(
      { system: MAIL_SWARM_ID, agentId: MAIL_AGENT_ID },
      { prompt: 'work', taskId: dispatch.id, role: 'worker' },
    );

    const meta = transport.recorded[0].message.body.metadata as Record<string, unknown> | undefined;
    expect(meta?.repo_id).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────
  // clone_policy='none' is NOT surfaced in envelope (default, omitted)
  // ─────────────────────────────────────────────────────────────────────

  it('clone_policy=none is omitted from envelope metadata', async () => {
    const dispatch = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_no_clone',
      spec_id: 'no-clone-001',
      target_swarm_id: MAIL_SWARM_ID,
      initiator_type: 'user',
      initiator_id: agentId,
      repo_id: repoId,
      clone_policy: 'none',
    });

    const source = createOpenHiveDispatchSource(makeSpecFetcher(), claimantId);
    const ready = await source.queryReady({ limit: 10 });
    ready.find((t) => t.id === dispatch.id);

    const transport = createRecordingTransport();
    const mailPort = createOpenHiveMailPort(transport);
    await mailPort.deliver(
      { system: MAIL_SWARM_ID, agentId: MAIL_AGENT_ID },
      { prompt: 'work', taskId: dispatch.id, role: 'worker' },
    );

    const meta = transport.recorded[0].message.body.metadata as Record<string, unknown>;
    expect(meta.repo_id).toBe(repoId);
    // clone_policy='none' should NOT be present — it's the default, omitted to keep envelopes lean.
    expect(meta.clone_policy).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Dispatch row persistence: canonical_url written back after resolve
  // ─────────────────────────────────────────────────────────────────────

  it('persists resolved canonical_url back to the dispatch row', async () => {
    const dispatch = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_persist',
      spec_id: 'persist-001',
      target_swarm_id: MAIL_SWARM_ID,
      initiator_type: 'user',
      initiator_id: agentId,
      repo_id: repoId,
      // canonical_url not set — should be resolved and persisted.
    });

    const source = createOpenHiveDispatchSource(makeSpecFetcher(), claimantId);
    await source.queryReady({ limit: 10 });

    // Re-read the dispatch row — canonical_url should now be persisted.
    const updated = dispatchesDAL.findDispatchById(dispatch.id);
    expect(updated?.canonical_url).toBe(REPO_CANONICAL_URL);
  });
});

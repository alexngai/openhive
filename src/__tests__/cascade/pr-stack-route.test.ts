/**
 * Route-level tests for `POST /cascade/streams/:id/pr-stack`.
 *
 * Mocks `github-api.js` so we can drive branchExists / createPullRequest /
 * findOpenPRByHead per-entry and verify the walker → route plumbing:
 *
 *   - status mapping (created / existing / push_required / blocked_by_parent / failed)
 *   - lineage propagation: A push_required → A.descendants blocked, A.siblings unaffected
 *   - D19 idempotency: existing PR short-circuits; 422 race recovers to existing
 *   - D21 push hint fires per entry (verified via sendCascadeAction mock)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import {
  upsertStream,
  updatePublishBranch,
  updateStreamStatus,
  createPR,
} from '../../db/dal/cascade-streams.js';
import { createSwarm } from '../../db/dal/map.js';
import { createResource } from '../../db/dal/syncable-resources.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import type { GitHubPR } from '../../integrations/github-api.js';

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

// Per-test driver for GitHub responses. Drivers can be swapped in
// beforeEach without re-mounting the module.
interface GitHubDriver {
  branchesOnOrigin: Set<string>;
  prsByHead: Map<string, GitHubPR>;
  // Optional: branchExists throws when set (e.g. simulating 403 rate limit).
  branchExistsError?: Error;
  // Optional: createPullRequest throws when set (e.g. simulating 422).
  createPullRequestError?: Error;
}
const driver: GitHubDriver = {
  branchesOnOrigin: new Set(),
  prsByHead: new Map(),
};

vi.mock('../../integrations/github-api.js', () => ({
  branchExists: vi.fn(async (_owner: string, _repo: string, branch: string) => {
    if (driver.branchExistsError) throw driver.branchExistsError;
    return driver.branchesOnOrigin.has(branch);
  }),
  createPullRequest: vi.fn(async (params: {
    head: string; base: string; title: string; draft?: boolean;
  }) => {
    if (driver.createPullRequestError) throw driver.createPullRequestError;
    const pr: GitHubPR = {
      number: Math.floor(Math.random() * 1000),
      html_url: `https://example.com/pulls/${params.head}`,
      state: 'open',
      merged: false,
      title: params.title,
      head: { ref: params.head },
      base: { ref: params.base },
      draft: params.draft ?? false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      merged_at: null,
    };
    return pr;
  }),
  findOpenPRByHead: vi.fn(async (_owner: string, _repo: string, branch: string) => {
    return driver.prsByHead.get(branch) ?? null;
  }),
  parseGitHubRepo: vi.fn((url: string) => {
    const m = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
    return m ? { owner: m[1], repo: m[2] } : null;
  }),
  // Unused on this route but imported by routes/cascade.ts via the same
  // import block — keep them stubbed so the module loads.
  updatePullRequest: vi.fn(),
  closePullRequest: vi.fn(),
  getPullRequest: vi.fn(),
  checkGitHubConnection: vi.fn(async () => ({ connected: true })),
}));

// sendCascadeAction is fire-and-forget; we just need to count invocations.
// `vi.hoisted` avoids the ReferenceError that vi.mock's hoisting causes
// when the factory references a top-level const.
const { sendCascadeActionMock } = vi.hoisted(() => ({
  sendCascadeActionMock: vi.fn(() => ({ sent: true })),
}));
vi.mock('../../map/cascade-actions.js', async () => {
  const actual = await vi.importActual<typeof import('../../map/cascade-actions.js')>(
    '../../map/cascade-actions.js',
  );
  return {
    ...actual,
    sendCascadeAction: sendCascadeActionMock,
  };
});

import { cascadeRoutes } from '../../api/routes/cascade.js';

// ── Test app ────────────────────────────────────────────────────────

const TEST_ROOT = testRoot('pr-stack-route');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'pr-stack-route.db');
const SWARM = 'pr-stack-swarm';

async function createTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('agent');
  await app.register(
    async (api) => { await api.register(cascadeRoutes); },
    { prefix: '/api/v1' },
  );
  return app;
}

// ── Fixtures ────────────────────────────────────────────────────────

interface StreamSpec {
  stream_id: string;
  parent?: string;
  publish_branch?: string;
  status?: 'active' | 'merged' | 'abandoned' | 'conflicted';
}

interface SetupResult {
  rowByStream: Map<string, string>;
  resourceId: string;
}

async function setupStack(
  agentId: string,
  ownerId: string,
  specs: StreamSpec[],
): Promise<SetupResult> {
  const resource = createResource({
    resource_type: 'task',
    name: `pr-stack-task-${Math.random().toString(36).slice(2, 8)}`,
    owner_agent_id: ownerId,
    git_remote_url: 'https://github.com/example/repo',
  });
  const rowByStream = new Map<string, string>();
  for (const spec of specs) {
    const { stream } = upsertStream({
      stream_id: spec.stream_id,
      source_swarm_id: SWARM,
      source_agent_id: agentId,
      name: spec.stream_id,
      parent_stream_id: spec.parent,
      task_resource_id: resource.id,
    });
    rowByStream.set(spec.stream_id, stream.id);
    if (spec.publish_branch) updatePublishBranch(stream.id, spec.publish_branch);
    if (spec.status) updateStreamStatus(stream.id, spec.status);
  }
  return { rowByStream, resourceId: resource.id };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('POST /cascade/streams/:id/pr-stack', () => {
  let app: FastifyInstance;
  let apiKey: string;
  let agentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent, apiKey: key } = await agentsDAL.createAgent({
      name: 'pr-stack-route-owner',
      description: 'test',
      is_admin: true,
    });
    agentId = agent.id;
    apiKey = key;
    // Seed swarm
    createSwarm(agentId, {
      id: SWARM,
      name: SWARM,
      map_endpoint: 'inline',
      map_transport: 'websocket',
      auth_method: 'none',
    });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    const db = getDatabase();
    db.prepare('DELETE FROM cascade_changes').run();
    db.prepare('DELETE FROM cascade_pull_requests').run();
    db.prepare('DELETE FROM cascade_streams').run();
    // syncable_resources has a UNIQUE constraint on
    // (owner_agent_id, resource_type, git_remote_url) so we need to
    // clean between tests that share the same git_remote_url.
    db.prepare('DELETE FROM syncable_resources').run();
    driver.branchesOnOrigin.clear();
    driver.prsByHead.clear();
    driver.branchExistsError = undefined;
    driver.createPullRequestError = undefined;
    sendCascadeActionMock.mockClear();
  });

  async function postStack(rowId: string): Promise<{
    statusCode: number;
    body: { data?: { entries: Array<Record<string, unknown>>; trunk: string }; error?: string; message?: string };
  }> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cascade/streams/${rowId}/pr-stack`,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return { statusCode: res.statusCode, body: res.json() };
  }

  it('creates one PR per active stream in a linear chain', async () => {
    const { rowByStream } = await setupStack(agentId, agentId, [
      { stream_id: 'A', publish_branch: 'feat/a' },
      { stream_id: 'B', parent: 'A', publish_branch: 'feat/b' },
    ]);
    driver.branchesOnOrigin.add('feat/a');
    driver.branchesOnOrigin.add('feat/b');

    const res = await postStack(rowByStream.get('A')!);
    expect(res.statusCode).toBe(200);
    const entries = res.body.data!.entries;
    expect(entries.map((e) => e.cascade_stream_id)).toEqual(['A', 'B']);
    expect(entries.every((e) => e.result_status === 'created')).toBe(true);
    expect(entries[0].pr_url).toBeTruthy();
    expect(entries[1].pr_url).toBeTruthy();
    // Push hint fired for each entry.
    expect(sendCascadeActionMock).toHaveBeenCalledTimes(2);
  });

  it('blocks descendants in lineage when ancestor is push_required (D18)', async () => {
    const { rowByStream } = await setupStack(agentId, agentId, [
      { stream_id: 'A', publish_branch: 'feat/a' },
      { stream_id: 'B', parent: 'A', publish_branch: 'feat/b' },
      { stream_id: 'C', parent: 'B', publish_branch: 'feat/c' },
    ]);
    // A is missing from origin → push_required; B + C blocked.
    driver.branchesOnOrigin.add('feat/b');
    driver.branchesOnOrigin.add('feat/c');

    const res = await postStack(rowByStream.get('A')!);
    expect(res.statusCode).toBe(200);
    const byStream = Object.fromEntries(
      res.body.data!.entries.map((e) => [e.cascade_stream_id, e.result_status]),
    );
    expect(byStream).toEqual({
      A: 'push_required',
      B: 'blocked_by_parent',
      C: 'blocked_by_parent',
    });
  });

  it('does not block siblings of a push_required ancestor (D20)', async () => {
    // A → {B, C} branching. B is push_required, C should still proceed.
    const { rowByStream } = await setupStack(agentId, agentId, [
      { stream_id: 'A', publish_branch: 'feat/a' },
      { stream_id: 'B', parent: 'A', publish_branch: 'feat/b' },
      { stream_id: 'C', parent: 'A', publish_branch: 'feat/c' },
    ]);
    driver.branchesOnOrigin.add('feat/a');
    driver.branchesOnOrigin.add('feat/c');
    // feat/b missing → B push_required

    const res = await postStack(rowByStream.get('A')!);
    const byStream = Object.fromEntries(
      res.body.data!.entries.map((e) => [e.cascade_stream_id, e.result_status]),
    );
    expect(byStream.A).toBe('created');
    expect(byStream.B).toBe('push_required');
    expect(byStream.C).toBe('created');
  });

  it('returns existing on idempotent retry (D19)', async () => {
    const { rowByStream } = await setupStack(agentId, agentId, [
      { stream_id: 'A', publish_branch: 'feat/a' },
    ]);
    driver.branchesOnOrigin.add('feat/a');
    // Pre-seed a PR for the stream so getPRForStream short-circuits.
    createPR({
      stream_row_id: rowByStream.get('A')!,
      source_branch: 'feat/a',
      target_branch: 'main',
      title: 'Existing PR',
      repo_owner: 'example',
      repo_name: 'repo',
      remote_pr_number: 42,
      remote_pr_url: 'https://example.com/pulls/42',
      state: 'open',
    });

    const res = await postStack(rowByStream.get('A')!);
    expect(res.statusCode).toBe(200);
    const entry = res.body.data!.entries[0];
    expect(entry.result_status).toBe('existing');
    expect(entry.pr_url).toBe('https://example.com/pulls/42');
    expect(entry.pr_number).toBe(42);
  });

  it('recovers from GitHub 422 race via findOpenPRByHead (D19)', async () => {
    const { rowByStream } = await setupStack(agentId, agentId, [
      { stream_id: 'A', publish_branch: 'feat/a' },
    ]);
    driver.branchesOnOrigin.add('feat/a');
    // Simulate the 422 race: createPullRequest throws with → 422, but the
    // PR actually exists when we look it up by head.
    driver.createPullRequestError = new Error(
      'GitHub API POST /repos/example/repo/pulls → 422: A pull request already exists for example:feat/a',
    );
    driver.prsByHead.set('feat/a', {
      number: 99,
      html_url: 'https://example.com/pulls/99',
      state: 'open',
      merged: false,
      title: 'Already open',
      head: { ref: 'feat/a' },
      base: { ref: 'main' },
      draft: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      merged_at: null,
    });

    const res = await postStack(rowByStream.get('A')!);
    const entry = res.body.data!.entries[0];
    expect(entry.result_status).toBe('existing');
    expect(entry.pr_url).toBe('https://example.com/pulls/99');
    expect(entry.pr_number).toBe(99);
  });

  it('marks entry failed when branchExists throws (e.g. rate limit)', async () => {
    const { rowByStream } = await setupStack(agentId, agentId, [
      { stream_id: 'A', publish_branch: 'feat/a' },
    ]);
    driver.branchExistsError = new Error(
      'GitHub API GET /repos/example/repo/branches/feat/a → 403: rate limit',
    );
    const res = await postStack(rowByStream.get('A')!);
    const entry = res.body.data!.entries[0];
    expect(entry.result_status).toBe('failed');
    expect((entry.error as string).length).toBeGreaterThan(0);
  });

  it('404 when stream root is unknown', async () => {
    const res = await postStack('does-not-exist');
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('400 when stream has no GitHub git_remote_url', async () => {
    // Create a stream tied to a resource with a non-github URL.
    const resource = createResource({
      resource_type: 'task',
      name: 'no-gh-task',
      owner_agent_id: agentId,
      git_remote_url: 'https://gitlab.com/example/repo',
    });
    const { stream } = upsertStream({
      stream_id: 'no-gh',
      source_swarm_id: SWARM,
      source_agent_id: agentId,
      name: 'no-gh',
      task_resource_id: resource.id,
    });

    const res = await postStack(stream.id);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('bad_request');
  });
});

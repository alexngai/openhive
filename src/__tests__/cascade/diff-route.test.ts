/**
 * Route-level tests for `GET /cascade/streams/:id/commits/:hash/diff`.
 *
 * Mocks the resolver (the underlying chain is exhaustively covered by
 * diff-chain-e2e.test.ts) so this file focuses on the *route surface*:
 *
 *   - 200 with payload on success
 *   - 401 without bearer token (auth gate)
 *   - HTTP status mapping for each DiffError code
 *   - Query-param plumbing (file, base, files_only)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import type { DiffResult } from '../../cascade/diff-types.js';

// Mocking the resolver lets us drive each branch of the HTTP-status mapping
// from one harness without standing up a real stream + sidecar.
const resolveMock = vi.fn<
  (args: Record<string, unknown>) => Promise<DiffResult>
>();
const resolveStreamMock = vi.fn<
  (args: Record<string, unknown>) => Promise<DiffResult>
>();
// Stack resolver returns a DiffResult + optional `stack` echo block.
const resolveStackMock = vi.fn<
  (args: Record<string, unknown>) => Promise<DiffResult & { stack?: unknown }>
>();

vi.mock('../../cascade/diff-resolver.js', () => ({
  resolveCommitDiff: (args: Record<string, unknown>) => resolveMock(args),
  resolveStreamDiff: (args: Record<string, unknown>) => resolveStreamMock(args),
  resolveStackDiff: (args: Record<string, unknown>) => resolveStackMock(args),
}));

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

import { cascadeRoutes } from '../../api/routes/cascade.js';

const TEST_ROOT = testRoot('cascade-diff-route');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'diff-route.db');

async function createTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('agent');
  await app.register(
    async (api) => { await api.register(cascadeRoutes); },
    { prefix: '/api/v1' },
  );
  return app;
}

// File-level DB lifecycle so multiple describe blocks share one fixture.
// Each describe spins up its own fastify app + agent.
beforeAll(() => {
  initDatabase(TEST_DB_PATH);
});

afterAll(() => {
  closeDatabase();
  cleanTestRoot(TEST_ROOT);
});

describe('GET /cascade/streams/:id/commits/:hash/diff', () => {
  let app: FastifyInstance;
  let apiKey: string;
  const STREAM_ROW_ID = 'stream-row-1';
  const COMMIT = 'a'.repeat(40);
  const URL = `/api/v1/cascade/streams/${STREAM_ROW_ID}/commits/${COMMIT}/diff`;

  beforeAll(async () => {
    const { apiKey: key } = await agentsDAL.createAgent({
      name: 'diff-route-test',
      description: 'route test',
    });
    apiKey = key;
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resolveMock.mockReset();
  });

  // ── Success path ────────────────────────────────────────────────────

  it('200 with payload on success', async () => {
    resolveMock.mockResolvedValueOnce({
      ok: true,
      payload: {
        diff: 'diff --git a/x b/x\n',
        files_touched: ['x'],
        truncated: false,
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: URL,
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { diff: string; files_touched: string[]; truncated: boolean } };
    expect(body.data.diff).toBe('diff --git a/x b/x\n');
    expect(body.data.files_touched).toEqual(['x']);
    expect(body.data.truncated).toBe(false);
  });

  // ── Auth gate ────────────────────────────────────────────────────────

  it('401 without Authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(401);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('401 with malformed bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: URL,
      headers: { Authorization: 'Bearer not-a-real-key' },
    });
    expect(res.statusCode).toBe(401);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  // ── Error-code → HTTP status mapping (diffErrorStatus) ───────────────

  it.each([
    ['not_found', 404],
    ['bad_request', 400],
    ['timeout', 504],
    ['integrity_failed', 502],
    ['swarm_offline', 503],
    ['capability_missing', 503],
    ['internal', 500],
  ] as const)('maps %s → HTTP %d', async (code, status) => {
    resolveMock.mockResolvedValueOnce({
      ok: false,
      error: { code, message: `simulated ${code}` },
    });
    const res = await app.inject({
      method: 'GET',
      url: URL,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.statusCode).toBe(status);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe(code);
    expect(body.message).toBe(`simulated ${code}`);
  });

  // ── Query-param plumbing ─────────────────────────────────────────────

  it('forwards ?file, ?base, ?files_only to the resolver', async () => {
    resolveMock.mockResolvedValueOnce({
      ok: true,
      payload: { diff: '', files_touched: ['x'], truncated: false },
    });

    await app.inject({
      method: 'GET',
      url: `${URL}?file=src/foo.ts&base=bbb&files_only=true`,
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    expect(resolveMock).toHaveBeenCalledTimes(1);
    const arg = resolveMock.mock.calls[0][0] as {
      stream_row_id: string;
      commit_hash: string;
      base_hash?: string;
      file_path?: string;
      files_only?: boolean;
    };
    expect(arg.stream_row_id).toBe(STREAM_ROW_ID);
    expect(arg.commit_hash).toBe(COMMIT);
    expect(arg.base_hash).toBe('bbb');
    expect(arg.file_path).toBe('src/foo.ts');
    expect(arg.files_only).toBe(true);
  });

  it('omits files_only when query value is not literally "true"', async () => {
    resolveMock.mockResolvedValueOnce({
      ok: true,
      payload: { diff: '', files_touched: [], truncated: false },
    });

    await app.inject({
      method: 'GET',
      url: `${URL}?files_only=1`,
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const arg = resolveMock.mock.calls[0][0] as { files_only?: boolean };
    expect(arg.files_only).toBe(false);
  });
});

// ============================================================================
// Stream 2 — stream-level + stack-level routes
// ============================================================================

describe('GET /cascade/streams/:id/diff (stream-level)', () => {
  let app: FastifyInstance;
  let apiKey: string;
  const STREAM_ROW_ID = 'stream-row-stream-diff';
  const URL = `/api/v1/cascade/streams/${STREAM_ROW_ID}/diff`;

  beforeAll(async () => {
    const { apiKey: key } = await agentsDAL.createAgent({
      name: 'stream-diff-route-test',
      description: 'route test',
    });
    apiKey = key;
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resolveStreamMock.mockReset();
  });

  it('200 with payload on success', async () => {
    resolveStreamMock.mockResolvedValueOnce({
      ok: true,
      payload: { diff: 'whole-stream diff', files_touched: ['x'], truncated: false },
    });
    const res = await app.inject({
      method: 'GET',
      url: URL,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { diff: string } };
    expect(body.data.diff).toBe('whole-stream diff');
  });

  it('forwards file + files_only query params', async () => {
    resolveStreamMock.mockResolvedValueOnce({
      ok: true,
      payload: { diff: '', files_touched: ['a'], truncated: false },
    });
    await app.inject({
      method: 'GET',
      url: `${URL}?file=src/a.ts&files_only=true`,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const arg = resolveStreamMock.mock.calls[0][0] as {
      stream_row_id: string;
      file_path?: string;
      files_only?: boolean;
    };
    expect(arg.stream_row_id).toBe(STREAM_ROW_ID);
    expect(arg.file_path).toBe('src/a.ts');
    expect(arg.files_only).toBe(true);
  });

  it('maps not_found → 404', async () => {
    resolveStreamMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'not_found', message: 'stream not found' },
    });
    const res = await app.inject({
      method: 'GET',
      url: URL,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('maps bad_request (no base / no commits) → 400', async () => {
    resolveStreamMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'bad_request', message: 'stream has no commits' },
    });
    const res = await app.inject({
      method: 'GET',
      url: URL,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /cascade/streams/:id/stack/diff (stack-level)', () => {
  let app: FastifyInstance;
  let apiKey: string;
  const ROOT_ROW_ID = 'stack-root-row';
  const URL = `/api/v1/cascade/streams/${ROOT_ROW_ID}/stack/diff`;

  beforeAll(async () => {
    const { apiKey: key } = await agentsDAL.createAgent({
      name: 'stack-diff-route-test',
      description: 'route test',
    });
    apiKey = key;
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resolveStackMock.mockReset();
  });

  it('200 with payload + stack echo', async () => {
    resolveStackMock.mockResolvedValueOnce({
      ok: true,
      payload: { diff: 'stack diff', files_touched: ['x'], truncated: false },
      stack: { entries: [], lowest_base: 'b', highest_head: 'h', root: {}, leaf: {} } as never,
    });
    const res = await app.inject({
      method: 'GET',
      url: URL,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { diff: string }; stack: unknown };
    expect(body.data.diff).toBe('stack diff');
    expect(body.stack).toBeDefined();
  });

  it('translates non_linear_stack to 400 with dedicated error code', async () => {
    resolveStackMock.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'bad_request',
        message:
          'non_linear_stack: Stack is non-linear at A (2 active children)',
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: URL,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe('non_linear_stack');
    expect(body.message).toContain('Stack is non-linear');
  });

  it('passes through other bad_request errors as-is', async () => {
    resolveStackMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'bad_request', message: 'stack root has no commits' },
    });
    const res = await app.inject({
      method: 'GET',
      url: URL,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
  });

  it('forwards file + files_only', async () => {
    resolveStackMock.mockResolvedValueOnce({
      ok: true,
      payload: { diff: '', files_touched: [], truncated: false },
    });
    await app.inject({
      method: 'GET',
      url: `${URL}?file=src/x.ts&files_only=true`,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const arg = resolveStackMock.mock.calls[0][0] as {
      stack_root_row_id: string;
      file_path?: string;
      files_only?: boolean;
    };
    expect(arg.stack_root_row_id).toBe(ROOT_ROW_ID);
    expect(arg.file_path).toBe('src/x.ts');
    expect(arg.files_only).toBe(true);
  });
});

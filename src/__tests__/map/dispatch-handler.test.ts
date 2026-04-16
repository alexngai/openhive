/**
 * Tests for the MAP dispatch handler — `map/dispatches/report`.
 *
 * Per D11/D15: agents may report `running` (acknowledgement) or `complete`/
 * `failed` (terminal) on dispatches the hub created. Cancelled and terminal
 * dispatches are immutable from the agent side.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const broadcastSpy = vi.fn();
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: (channel: string, event: unknown) => broadcastSpy(channel, event),
  broadcast: vi.fn(),
}));

import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as dispatches from '../../db/dal/dispatches.js';
import {
  handleDispatchRequest,
  MAPDispatchRequestError,
  MAP_DISPATCH_METHODS,
} from '../../map/dispatch-handler.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('dispatch-handler');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'dispatch-handler.db');

function seedDispatch(overrides: Partial<dispatches.CreateDispatchInput> = {}): dispatches.Dispatch {
  return dispatches.createDispatch({
    spec_resource_id: 'res_a',
    spec_id: 'c-aaa',
    target_swarm_id: 'swarm_x',
    initiator_type: 'user',
    initiator_id: 'u',
    ...overrides,
  });
}

describe('MAP dispatch handler', () => {
  beforeAll(() => {
    initDatabase(TEST_DB_PATH);
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    getDatabase().prepare('DELETE FROM dispatches').run();
    broadcastSpy.mockClear();
  });

  it('flips queued → running on report status=running and broadcasts dispatch.status_changed', async () => {
    const d = seedDispatch();
    const result = await handleDispatchRequest(
      MAP_DISPATCH_METHODS.REPORT,
      { dispatch_id: d.id, status: 'running' },
      { swarmId: 'swarm_x', agentId: 'agent-1' },
    );
    const updated = (result as { dispatch: dispatches.Dispatch }).dispatch;
    expect(updated.status).toBe('running');

    expect(broadcastSpy).toHaveBeenCalledWith(
      'map:dispatches',
      expect.objectContaining({
        type: 'dispatch.status_changed',
        data: expect.objectContaining({
          reporter: { type: 'agent', id: 'agent-1', swarm_id: 'swarm_x' },
        }),
      }),
    );
  });

  it('flips to complete with outcome and broadcasts dispatch.completed', async () => {
    const d = seedDispatch();
    await handleDispatchRequest(
      MAP_DISPATCH_METHODS.REPORT,
      { dispatch_id: d.id, status: 'running' },
      { swarmId: 'swarm_x', agentId: 'agent-1' },
    );
    broadcastSpy.mockClear();

    const outcome = { summary: 'shipped', artifacts: [{ kind: 'pr', ref: 'gh:o/r#1' }] };
    const result = await handleDispatchRequest(
      MAP_DISPATCH_METHODS.REPORT,
      { dispatch_id: d.id, status: 'complete', outcome },
      { swarmId: 'swarm_x', agentId: 'agent-1' },
    );
    const updated = (result as { dispatch: dispatches.Dispatch }).dispatch;
    expect(updated.status).toBe('complete');
    expect(updated.outcome?.summary).toBe('shipped');

    expect(broadcastSpy).toHaveBeenCalledWith(
      'map:dispatches',
      expect.objectContaining({ type: 'dispatch.completed' }),
    );
  });

  it('flips to failed with error outcome', async () => {
    const d = seedDispatch();
    await handleDispatchRequest(
      MAP_DISPATCH_METHODS.REPORT,
      { dispatch_id: d.id, status: 'failed', outcome: { error: 'crashed' } },
      { swarmId: 'swarm_x', agentId: 'agent-1' },
    );
    const reloaded = dispatches.findDispatchById(d.id);
    expect(reloaded?.status).toBe('failed');
    expect(reloaded?.outcome?.error).toBe('crashed');
  });

  it('rejects unknown method', async () => {
    await expect(
      handleDispatchRequest(
        'map/dispatches/bogus',
        {},
        { swarmId: 'x', agentId: 'a' },
      ),
    ).rejects.toBeInstanceOf(MAPDispatchRequestError);
  });

  it('rejects missing dispatch_id', async () => {
    await expect(
      handleDispatchRequest(
        MAP_DISPATCH_METHODS.REPORT,
        { status: 'running' },
        { swarmId: 'x', agentId: 'a' },
      ),
    ).rejects.toThrow(/dispatch_id/);
  });

  it('rejects status outside the agent-reportable set (e.g. cancelled, queued)', async () => {
    const d = seedDispatch();
    await expect(
      handleDispatchRequest(
        MAP_DISPATCH_METHODS.REPORT,
        { dispatch_id: d.id, status: 'cancelled' },
        { swarmId: 'x', agentId: 'a' },
      ),
    ).rejects.toThrow(/agent-reportable transitions/);

    await expect(
      handleDispatchRequest(
        MAP_DISPATCH_METHODS.REPORT,
        { dispatch_id: d.id, status: 'queued' },
        { swarmId: 'x', agentId: 'a' },
      ),
    ).rejects.toThrow(/agent-reportable transitions/);
  });

  it('returns 32001 for unknown dispatch id', async () => {
    await expect(
      handleDispatchRequest(
        MAP_DISPATCH_METHODS.REPORT,
        { dispatch_id: 'disp_nope', status: 'running' },
        { swarmId: 'x', agentId: 'a' },
      ),
    ).rejects.toMatchObject({ code: -32001 });
  });

  it('rejects reports on cancelled dispatches', async () => {
    const d = seedDispatch();
    dispatches.cancelDispatch(d.id);
    await expect(
      handleDispatchRequest(
        MAP_DISPATCH_METHODS.REPORT,
        { dispatch_id: d.id, status: 'running' },
        { swarmId: 'x', agentId: 'a' },
      ),
    ).rejects.toThrow(/cancelled/);
  });

  it('rejects reports on terminal dispatches', async () => {
    const d = seedDispatch();
    dispatches.updateDispatchStatus(d.id, 'complete', { summary: 'done' });
    await expect(
      handleDispatchRequest(
        MAP_DISPATCH_METHODS.REPORT,
        { dispatch_id: d.id, status: 'running' },
        { swarmId: 'x', agentId: 'a' },
      ),
    ).rejects.toThrow(/terminal/);
  });
});

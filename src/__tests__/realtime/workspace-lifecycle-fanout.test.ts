/**
 * Structural-symmetry test for the workspace-lifecycle fan-out contract.
 *
 * Asserts that `broadcastWorkspaceLifecycleEvent` writes to BOTH
 * the fleet `map:repos` channel AND the per-repo `map:repo:${repoId}`
 * channel for every event in the `WorkspaceLifecycleEvent` union.
 *
 * Mirrors the pattern in `swarm-lifecycle-fanout.test.ts` — adding a new
 * event type to the union without updating the helper would cause this
 * test to fail.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

import { broadcastToChannel } from '../../realtime/index.js';
import {
  broadcastWorkspaceLifecycleEvent,
  type WorkspaceLifecycleEvent,
} from '../../realtime/workspace-events.js';
import type { Workspace } from '../../types.js';

const mockedBroadcast = vi.mocked(broadcastToChannel);

const REPO_ID = 'repo_test';

const stubWorkspace: Workspace = {
  id: 'ws_test',
  repo_id: REPO_ID,
  agent_id: 'a1',
  swarm_id: 's1',
  local_path: '/tmp/test',
  current_branch: 'main',
  head_sha: null,
  dirty: 0,
  instance_label: null,
  visibility: 'hub_local',
  is_active: 1,
  created_at: '2026-05-06T00:00:00Z',
  updated_at: '2026-05-06T00:00:00Z',
  last_seen_at: '2026-05-06T00:00:00Z',
};

/** Every event type in the union — keep in sync if the union changes. */
const ALL_EVENTS: WorkspaceLifecycleEvent[] = [
  { type: 'workspace_added', data: { workspace: stubWorkspace } },
  { type: 'workspace_changed', data: { workspace: stubWorkspace } },
  { type: 'workspace_deactivated', data: { workspace_id: 'ws_x', repo_id: REPO_ID, agent_id: 'a1' } },
  { type: 'repo_visibility_changed', data: { repo_id: REPO_ID, new_visibility: 'private' } },
  { type: 'repo_archived', data: { repo_id: REPO_ID } },
];

describe('broadcastWorkspaceLifecycleEvent — structural symmetry', () => {
  beforeEach(() => {
    mockedBroadcast.mockClear();
  });

  it.each(ALL_EVENTS)(
    'event type "$type" fans out to BOTH map:repos and map:repo:{id}',
    (event) => {
      broadcastWorkspaceLifecycleEvent(REPO_ID, event);

      expect(mockedBroadcast).toHaveBeenCalledTimes(2);
      const channels = mockedBroadcast.mock.calls.map((c) => c[0]);
      expect(channels).toContain('map:repos');
      expect(channels).toContain(`map:repo:${REPO_ID}`);

      // Same event delivered to both channels.
      const fleetCall = mockedBroadcast.mock.calls.find((c) => c[0] === 'map:repos')!;
      const perRepoCall = mockedBroadcast.mock.calls.find((c) => c[0] === `map:repo:${REPO_ID}`)!;
      expect(fleetCall[1]).toEqual(event);
      expect(perRepoCall[1]).toEqual(event);
    },
  );

  it('different repoIds produce different per-repo channels', () => {
    broadcastWorkspaceLifecycleEvent('repo_a', ALL_EVENTS[0]!);
    broadcastWorkspaceLifecycleEvent('repo_b', ALL_EVENTS[0]!);

    const channels = mockedBroadcast.mock.calls.map((c) => c[0]);
    expect(channels).toContain('map:repo:repo_a');
    expect(channels).toContain('map:repo:repo_b');
  });
});

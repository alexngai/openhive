/**
 * DAL test for findLiveAcpSession — the lookup helper that powers
 * Option 1B (multi-tab session sharing). Verifies the (owner, swarm,
 * acp_target_agent_id) match returns the most-recent session resource
 * with the right metadata, and that mismatched keys return null.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('find-live-acp-session');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'find-live-acp-session.db');

// Owner agent IDs are populated during beforeAll — syncable_resources
// has a FK on agents.id so we can't seed with arbitrary strings.
let OWNER = '';
let OTHER_OWNER = '';
const SWARM = 'swarm_x';
const OTHER_SWARM = 'swarm_y';
const TARGET = 'coord-1';
const OTHER_TARGET = 'coord-2';

function seedSession(opts: {
  owner: string;
  swarm: string;
  target: string;
  acpStreamId: string | null;
  sessionId: string | null;
  name?: string;
}) {
  return resourcesDAL.upsertDiscoveredResource({
    resource_type: 'session',
    name: opts.name ?? `session ${opts.target}`,
    git_remote_url: `map://session/${opts.sessionId ?? Date.now()}`,
    owner_agent_id: opts.owner,
    scope: 'manual',
    metadata: {
      source_swarm_id: opts.swarm,
      acp_target_agent_id: opts.target,
      acpStreamId: opts.acpStreamId,
      sessionId: opts.sessionId,
    },
  });
}

describe('resourcesDAL.findLiveAcpSession', () => {
  beforeAll(() => {
    initDatabase(TEST_DB_PATH);
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(async () => {
    // Wipe both tables and re-create owners. syncable_resources has a
    // FK on agents.id, so we need owners alive before each seed.
    const db = getDatabase();
    db.prepare('DELETE FROM syncable_resources').run();
    db.prepare('DELETE FROM agents').run();
    const a = await agentsDAL.createAgent({ name: 'owner-a' });
    const b = await agentsDAL.createAgent({ name: 'owner-b' });
    OWNER = a.agent.id;
    OTHER_OWNER = b.agent.id;
  });

  it('returns null when no matching session exists', () => {
    const found = resourcesDAL.findLiveAcpSession({
      ownerAgentId: OWNER, swarmId: SWARM, acpTargetAgentId: TARGET,
    });
    expect(found).toBeNull();
  });

  it('returns the matching session resource', () => {
    const { resource } = seedSession({
      owner: OWNER, swarm: SWARM, target: TARGET,
      acpStreamId: 'stream_1', sessionId: 'sess_1',
    });
    const found = resourcesDAL.findLiveAcpSession({
      ownerAgentId: OWNER, swarmId: SWARM, acpTargetAgentId: TARGET,
    });
    expect(found?.id).toBe(resource.id);
    expect((found?.metadata as Record<string, unknown>).acpStreamId).toBe('stream_1');
    expect((found?.metadata as Record<string, unknown>).sessionId).toBe('sess_1');
  });

  it('does not match a different owner (security: no cross-user piggyback)', () => {
    seedSession({
      owner: OTHER_OWNER, swarm: SWARM, target: TARGET,
      acpStreamId: 'stream_1', sessionId: 'sess_1',
    });
    const found = resourcesDAL.findLiveAcpSession({
      ownerAgentId: OWNER, swarmId: SWARM, acpTargetAgentId: TARGET,
    });
    expect(found).toBeNull();
  });

  it('does not match a different swarm or target agent', () => {
    seedSession({
      owner: OWNER, swarm: OTHER_SWARM, target: TARGET,
      acpStreamId: 'stream_1', sessionId: 'sess_1',
    });
    seedSession({
      owner: OWNER, swarm: SWARM, target: OTHER_TARGET,
      acpStreamId: 'stream_2', sessionId: 'sess_2',
    });
    const found = resourcesDAL.findLiveAcpSession({
      ownerAgentId: OWNER, swarmId: SWARM, acpTargetAgentId: TARGET,
    });
    expect(found).toBeNull();
  });

  it('skips rows missing acpStreamId or sessionId metadata', () => {
    seedSession({
      owner: OWNER, swarm: SWARM, target: TARGET,
      acpStreamId: null, sessionId: 'sess_orphan',
      name: 'no-stream',
    });
    seedSession({
      owner: OWNER, swarm: SWARM, target: TARGET,
      acpStreamId: 'stream_orphan', sessionId: null,
      name: 'no-session',
    });
    const found = resourcesDAL.findLiveAcpSession({
      ownerAgentId: OWNER, swarmId: SWARM, acpTargetAgentId: TARGET,
    });
    expect(found).toBeNull();
  });

  it('returns the most-recently-updated row when multiple match', () => {
    const a = seedSession({
      owner: OWNER, swarm: SWARM, target: TARGET,
      acpStreamId: 'stream_old', sessionId: 'sess_old', name: 'older',
    });
    const b = seedSession({
      owner: OWNER, swarm: SWARM, target: TARGET,
      acpStreamId: 'stream_new', sessionId: 'sess_new', name: 'newer',
    });
    // Bump b's updated_at directly (SQLite's datetime('now') has 1s
    // resolution and the two upserts run within the same second). This
    // avoids a sleep that the test runner has been racing on.
    getDatabase().prepare(`UPDATE syncable_resources SET updated_at = datetime('now', '+1 hour') WHERE id = ?`).run(b.resource.id);
    expect(a.resource.id).not.toBe(b.resource.id);

    const found = resourcesDAL.findLiveAcpSession({
      ownerAgentId: OWNER, swarmId: SWARM, acpTargetAgentId: TARGET,
    });
    expect(found?.id).toBe(b.resource.id);
    expect((found?.metadata as Record<string, unknown>).sessionId).toBe('sess_new');
  });
});

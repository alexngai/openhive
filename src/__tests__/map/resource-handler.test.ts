/**
 * Tests for MAP Resource Protocol handler (map/resources/list, map/resources/get).
 *
 * Covers: type namespace mapping, MAPResource envelope projection, per-type
 * dispatch (repo metadata-visibility vs column-level), pagination, error codes,
 * and access control scoping.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import {
  handleResourceList,
  handleResourceGet,
  toNamespacedType,
  toInternalType,
  getAdvertisedKinds,
} from '../../map/resource-handler.js';

const TEST_ROOT = testRoot('resource-handler');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'resource-handler.db');

const OWNER_ID = 'agent_owner';
const OTHER_AGENT = 'agent_other';
const SWARM_ID = 'swarm_test';

function ctxFor(agentId: string) {
  return { session: { metadata: { agentId, swarmId: SWARM_ID } } };
}

function seedAgent(id: string, name: string): void {
  const db = getDatabase();
  db.prepare('INSERT OR IGNORE INTO agents (id, name) VALUES (?, ?)').run(id, name);
}

function seedRepo(
  id: string,
  name: string,
  canonicalUrl: string,
  ownerId: string,
  metaVisibility: 'private' | 'hub_local' | 'federated' = 'hub_local',
): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  const metadata = JSON.stringify({
    name,
    origin: 'user_defined',
    visibility: metaVisibility,
  });
  db.prepare(`
    INSERT OR IGNORE INTO syncable_resources
    (id, resource_type, name, description, git_remote_url, visibility, owner_agent_id,
     scope, sync_strategy, metadata, created_at, updated_at, status)
    VALUES (?, 'repo', ?, '', ?, 'private', ?, 'manual', 'metadata', ?, ?, ?, 'active')
  `).run(id, name, canonicalUrl, ownerId, metadata, now, now);
}

function seedResource(
  id: string,
  type: string,
  name: string,
  ownerId: string,
  visibility: 'private' | 'shared' | 'public' = 'public',
): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO syncable_resources
    (id, resource_type, name, description, git_remote_url, visibility, owner_agent_id,
     scope, sync_strategy, metadata, created_at, updated_at, status)
    VALUES (?, ?, ?, '', ?, ?, ?, 'manual', 'metadata', '{}', ?, ?, 'active')
  `).run(id, type, name, `map://${type}/${id}`, visibility, ownerId, now, now);
}

describe('MAP Resource Handler', () => {
  beforeAll(() => {
    initDatabase(TEST_DB_PATH);
    seedAgent(OWNER_ID, 'Owner Agent');
    seedAgent(OTHER_AGENT, 'Other Agent');
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    const db = getDatabase();
    db.prepare('DELETE FROM syncable_resources').run();
  });

  // ── Type namespace mapping ────────────────────────────────────────────────

  describe('type namespace mapping', () => {
    it('maps internal types to namespaced types', () => {
      expect(toNamespacedType('repo')).toBe('x-workspace/repo');
      expect(toNamespacedType('memory_bank')).toBe('x-minimem/memory-bank');
      expect(toNamespacedType('session')).toBe('x-sessionlog/session');
      expect(toNamespacedType('task')).toBe('x-opentasks/task-board');
      expect(toNamespacedType('skill')).toBe('x-skill-tree/skill');
    });

    it('returns input unchanged for unknown internal types', () => {
      expect(toNamespacedType('unknown_thing')).toBe('unknown_thing');
    });

    it('maps namespaced types back to internal types', () => {
      expect(toInternalType('x-workspace/repo')).toBe('repo');
      expect(toInternalType('x-minimem/memory-bank')).toBe('memory_bank');
      expect(toInternalType('x-sessionlog/session')).toBe('session');
    });

    it('returns null for unknown namespaced types', () => {
      expect(toInternalType('x-unknown/thing')).toBeNull();
    });

    it('getAdvertisedKinds returns all namespaced types', () => {
      const kinds = getAdvertisedKinds();
      expect(kinds).toContain('x-workspace/repo');
      expect(kinds).toContain('x-minimem/memory-bank');
      expect(kinds).toContain('x-sessionlog/session');
      expect(kinds).toContain('x-opentasks/task-board');
      expect(kinds).toContain('x-skill-tree/skill');
      expect(kinds.length).toBeGreaterThanOrEqual(5);
    });
  });

  // ── map/resources/list ────────────────────────────────────────────────────

  describe('handleResourceList', () => {
    it('returns MAPResource envelope for repos', async () => {
      seedRepo('repo_1', 'my-repo', 'https://github.com/test/repo', OWNER_ID, 'hub_local');

      const result = await handleResourceList(
        { type: 'x-workspace/repo' },
        ctxFor(OWNER_ID),
      );

      expect(result.resources).toHaveLength(1);
      const r = result.resources[0];
      expect(r.id).toBe('repo_1');
      expect(r.type).toBe('x-workspace/repo');
      expect(r.name).toBe('my-repo');
      expect(r.status).toBe('active');
      expect(r.owner_id).toBe(OWNER_ID);
      expect(r.origin_hub_id).toBeNull();
      expect(r.created_at).toBeDefined();
      expect(r.updated_at).toBeDefined();
      expect(r.metadata).toBeDefined();
    });

    it('filters private repos by metadata visibility', async () => {
      seedRepo('repo_pub', 'public-repo', 'https://github.com/test/pub', OWNER_ID, 'hub_local');
      seedRepo('repo_priv', 'private-repo', 'https://github.com/test/priv', OTHER_AGENT, 'private');

      const result = await handleResourceList(
        { type: 'x-workspace/repo' },
        ctxFor(OWNER_ID),
      );

      expect(result.resources).toHaveLength(1);
      expect(result.resources[0].id).toBe('repo_pub');
    });

    it('private repo owner can see their own private repos', async () => {
      seedRepo('repo_priv', 'private-repo', 'https://github.com/test/priv', OWNER_ID, 'private');

      const result = await handleResourceList(
        { type: 'x-workspace/repo' },
        ctxFor(OWNER_ID),
      );

      expect(result.resources).toHaveLength(1);
      expect(result.resources[0].id).toBe('repo_priv');
    });

    it('returns non-repo resources via column-level visibility', async () => {
      seedResource('mem_1', 'memory_bank', 'my-memory', OWNER_ID, 'public');
      seedResource('mem_2', 'memory_bank', 'other-memory', OTHER_AGENT, 'private');

      const result = await handleResourceList(
        { type: 'x-minimem/memory-bank' },
        ctxFor(OWNER_ID),
      );

      expect(result.resources).toHaveLength(1);
      expect(result.resources[0].id).toBe('mem_1');
      expect(result.resources[0].type).toBe('x-minimem/memory-bank');
    });

    it('owner can see their own private non-repo resources', async () => {
      seedResource('mem_priv', 'memory_bank', 'private-memory', OWNER_ID, 'private');

      const result = await handleResourceList(
        { type: 'x-minimem/memory-bank' },
        ctxFor(OWNER_ID),
      );

      expect(result.resources).toHaveLength(1);
    });

    it('returns -32001 for unknown resource type', async () => {
      await expect(
        handleResourceList({ type: 'x-unknown/thing' }, ctxFor(OWNER_ID)),
      ).rejects.toMatchObject({ code: -32001 });
    });

    it('paginates results with cursor', async () => {
      seedRepo('repo_a', 'repo-a', 'https://github.com/test/a', OWNER_ID, 'hub_local');
      seedRepo('repo_b', 'repo-b', 'https://github.com/test/b', OWNER_ID, 'hub_local');
      seedRepo('repo_c', 'repo-c', 'https://github.com/test/c', OWNER_ID, 'hub_local');

      const page1 = await handleResourceList(
        { type: 'x-workspace/repo', limit: 2 },
        ctxFor(OWNER_ID),
      );

      expect(page1.resources).toHaveLength(2);
      expect(page1.cursor).not.toBeNull();
      expect(page1.total).toBe(3);

      const page2 = await handleResourceList(
        { type: 'x-workspace/repo', limit: 2, cursor: page1.cursor },
        ctxFor(OWNER_ID),
      );

      expect(page2.resources).toHaveLength(1);
      expect(page2.cursor).toBeNull();
    });

    it('returns empty list when no resources match', async () => {
      const result = await handleResourceList(
        { type: 'x-workspace/repo' },
        ctxFor(OWNER_ID),
      );

      expect(result.resources).toHaveLength(0);
      expect(result.cursor).toBeNull();
    });
  });

  // ── map/resources/get ─────────────────────────────────────────────────────

  describe('handleResourceGet', () => {
    it('returns a single resource by id', async () => {
      seedRepo('repo_get', 'get-repo', 'https://github.com/test/get', OWNER_ID, 'hub_local');

      const result = await handleResourceGet(
        { id: 'repo_get' },
        ctxFor(OWNER_ID),
      );

      expect(result.id).toBe('repo_get');
      expect(result.type).toBe('x-workspace/repo');
      expect(result.name).toBe('get-repo');
    });

    it('returns -32004 for non-existent resource', async () => {
      await expect(
        handleResourceGet({ id: 'nonexistent' }, ctxFor(OWNER_ID)),
      ).rejects.toMatchObject({ code: -32004 });
    });

    it('returns -32004 when type hint mismatches', async () => {
      seedRepo('repo_typed', 'typed-repo', 'https://github.com/test/typed', OWNER_ID);

      await expect(
        handleResourceGet(
          { id: 'repo_typed', type: 'x-minimem/memory-bank' },
          ctxFor(OWNER_ID),
        ),
      ).rejects.toMatchObject({ code: -32004 });
    });

    it('succeeds when type hint matches', async () => {
      seedRepo('repo_match', 'match-repo', 'https://github.com/test/match', OWNER_ID);

      const result = await handleResourceGet(
        { id: 'repo_match', type: 'x-workspace/repo' },
        ctxFor(OWNER_ID),
      );

      expect(result.id).toBe('repo_match');
    });

    it('blocks access to private repo for non-owner', async () => {
      seedRepo('repo_secret', 'secret', 'https://github.com/test/secret', OWNER_ID, 'private');

      await expect(
        handleResourceGet({ id: 'repo_secret' }, ctxFor(OTHER_AGENT)),
      ).rejects.toMatchObject({ code: -32004 });
    });

    it('allows owner to access their own private repo', async () => {
      seedRepo('repo_mine', 'mine', 'https://github.com/test/mine', OWNER_ID, 'private');

      const result = await handleResourceGet(
        { id: 'repo_mine' },
        ctxFor(OWNER_ID),
      );

      expect(result.id).toBe('repo_mine');
    });

    it('blocks access to private non-repo resource for non-owner', async () => {
      seedResource('mem_secret', 'memory_bank', 'secret-mem', OTHER_AGENT, 'private');

      await expect(
        handleResourceGet({ id: 'mem_secret' }, ctxFor(OWNER_ID)),
      ).rejects.toMatchObject({ code: -32004 });
    });

    it('allows access to public non-repo resource', async () => {
      seedResource('mem_pub', 'memory_bank', 'public-mem', OTHER_AGENT, 'public');

      const result = await handleResourceGet(
        { id: 'mem_pub' },
        ctxFor(OWNER_ID),
      );

      expect(result.id).toBe('mem_pub');
      expect(result.type).toBe('x-minimem/memory-bank');
    });
  });
});

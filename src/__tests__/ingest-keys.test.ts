/**
 * Tests for ingest API keys.
 *
 * Covers DAL CRUD, validation (revoke, expiry), auth middleware integration,
 * scope enforcement, and admin route CRUD.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase } from '../db/index.js';
import * as agentsDAL from '../db/dal/agents.js';
import * as ingestKeysDAL from '../db/dal/ingest-keys.js';
import { adminRoutes } from '../api/routes/admin.js';
import { sessionsRoutes } from '../api/routes/sessions.js';
import { mapRoutes } from '../api/routes/map.js';
import { resourcesRoutes } from '../api/routes/resources.js';
import { ConfigSchema, type Config } from '../config.js';
import { testRoot, testDbPath, cleanTestRoot } from './helpers/test-dirs.js';

const TEST_ROOT = testRoot('ingest-keys');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'ingest-keys.db');

const ADMIN_KEY = 'test-admin-key-12345';

function createTestConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test OpenHive', description: 'Test' },
    admin: { createOnStartup: false, key: ADMIN_KEY },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
  });
}

async function createTestApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(
    async (api) => {
      await api.register(adminRoutes, { config });
      await api.register(sessionsRoutes, { config });
      await api.register(mapRoutes, { config });
      await api.register(resourcesRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

describe('Ingest API Keys', () => {
  let agentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);

    const { agent } = await agentsDAL.createAgent({
      name: 'ingest-test-agent',
      description: 'Agent for ingest key tests',
    });
    agentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ═══════════════════════════════════════════════════════════════
  // DAL: createIngestKey
  // ═══════════════════════════════════════════════════════════════

  describe('createIngestKey', () => {
    it('should create an ingest key with ohk_ prefix', () => {
      const result = ingestKeysDAL.createIngestKey(agentId, {
        label: 'test-key',
        agent_id: agentId,
      });

      expect(result.plaintext_key).toMatch(/^ohk_/);
      expect(result.plaintext_key.length).toBeGreaterThan(4);
      expect(result.key.id).toMatch(/^ik_/);
      expect(result.key.label).toBe('test-key');
      expect(result.key.agent_id).toBe(agentId);
      expect(result.key.revoked).toBe(false);
      expect(result.key.expires_at).toBeNull();
      expect(result.key.created_by).toBe(agentId);
    });

    it('should hash the key with SHA-256 (not store plaintext)', () => {
      const result = ingestKeysDAL.createIngestKey(agentId, {
        label: 'hash-check',
        agent_id: agentId,
      });

      expect(result.key.key_hash).not.toBe(result.plaintext_key);
      expect(result.key.key_hash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    });

    it('should set expires_at when expires_in_hours is provided', () => {
      const result = ingestKeysDAL.createIngestKey(agentId, {
        label: 'expiring-key',
        agent_id: agentId,
        expires_in_hours: 24,
      });

      expect(result.key.expires_at).not.toBeNull();
      const expiresAt = new Date(result.key.expires_at!);
      const now = new Date();
      // Should expire roughly 24 hours from now (within 1 minute tolerance)
      const diffHours = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);
      expect(diffHours).toBeGreaterThan(23);
      expect(diffHours).toBeLessThan(25);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // DAL: validateIngestKey
  // ═══════════════════════════════════════════════════════════════

  describe('validateIngestKey', () => {
    it('should validate a correct plaintext key', () => {
      const { plaintext_key, key } = ingestKeysDAL.createIngestKey(agentId, {
        label: 'validate-test',
        agent_id: agentId,
      });

      const validated = ingestKeysDAL.validateIngestKey(plaintext_key);
      expect(validated).not.toBeNull();
      expect(validated!.id).toBe(key.id);
      expect(validated!.label).toBe('validate-test');
    });

    it('should return null for an invalid key', () => {
      const validated = ingestKeysDAL.validateIngestKey('ohk_nonexistent_key');
      expect(validated).toBeNull();
    });

    it('should return null for a revoked key', () => {
      const { plaintext_key, key } = ingestKeysDAL.createIngestKey(agentId, {
        label: 'revoke-validate',
        agent_id: agentId,
      });

      ingestKeysDAL.revokeIngestKey(key.id);

      const validated = ingestKeysDAL.validateIngestKey(plaintext_key);
      expect(validated).toBeNull();
    });

    it('should return null for an expired key', () => {
      const { plaintext_key } = ingestKeysDAL.createIngestKey(agentId, {
        label: 'expired-validate',
        agent_id: agentId,
        expires_in_hours: -1, // Already expired
      });

      const validated = ingestKeysDAL.validateIngestKey(plaintext_key);
      expect(validated).toBeNull();
    });

    it('should update last_used_at on successful validation', () => {
      const { plaintext_key, key } = ingestKeysDAL.createIngestKey(agentId, {
        label: 'last-used-test',
        agent_id: agentId,
      });

      expect(key.last_used_at).toBeNull();

      ingestKeysDAL.validateIngestKey(plaintext_key);

      const updated = ingestKeysDAL.findIngestKeyById(key.id);
      expect(updated!.last_used_at).not.toBeNull();
    });

    it('should return fresh last_used_at in the returned key', () => {
      const { plaintext_key } = ingestKeysDAL.createIngestKey(agentId, {
        label: 'fresh-last-used',
        agent_id: agentId,
      });

      const validated = ingestKeysDAL.validateIngestKey(plaintext_key);
      expect(validated).not.toBeNull();
      expect(validated!.last_used_at).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // DAL: revokeIngestKey
  // ═══════════════════════════════════════════════════════════════

  describe('revokeIngestKey', () => {
    it('should soft-revoke a key', () => {
      const { key } = ingestKeysDAL.createIngestKey(agentId, {
        label: 'revoke-test',
        agent_id: agentId,
      });

      const revoked = ingestKeysDAL.revokeIngestKey(key.id);
      expect(revoked).toBe(true);

      const fetched = ingestKeysDAL.findIngestKeyById(key.id);
      expect(fetched!.revoked).toBe(true);
    });

    it('should return false if key already revoked', () => {
      const { key } = ingestKeysDAL.createIngestKey(agentId, {
        label: 'double-revoke',
        agent_id: agentId,
      });

      ingestKeysDAL.revokeIngestKey(key.id);
      const secondRevoke = ingestKeysDAL.revokeIngestKey(key.id);
      expect(secondRevoke).toBe(false);
    });

    it('should return false for non-existent key', () => {
      const revoked = ingestKeysDAL.revokeIngestKey('ik_nonexistent');
      expect(revoked).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // DAL: listIngestKeys
  // ═══════════════════════════════════════════════════════════════

  describe('listIngestKeys', () => {
    it('should list active keys by default (exclude revoked)', () => {
      const keys = ingestKeysDAL.listIngestKeys();
      for (const k of keys) {
        expect(k.revoked).toBe(false);
      }
    });

    it('should include revoked keys when include_revoked=true', () => {
      const keys = ingestKeysDAL.listIngestKeys({ include_revoked: true });
      const hasRevoked = keys.some((k) => k.revoked);
      expect(hasRevoked).toBe(true);
    });

    it('should filter by agent_id', () => {
      const keys = ingestKeysDAL.listIngestKeys({ agent_id: agentId });
      for (const k of keys) {
        expect(k.agent_id).toBe(agentId);
      }
    });

    it('should respect limit', () => {
      const keys = ingestKeysDAL.listIngestKeys({ limit: 2 });
      expect(keys.length).toBeLessThanOrEqual(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // DAL: deleteIngestKey
  // ═══════════════════════════════════════════════════════════════

  describe('deleteIngestKey', () => {
    it('should hard-delete a key', () => {
      const { key } = ingestKeysDAL.createIngestKey(agentId, {
        label: 'delete-test',
        agent_id: agentId,
      });

      const deleted = ingestKeysDAL.deleteIngestKey(key.id);
      expect(deleted).toBe(true);

      const fetched = ingestKeysDAL.findIngestKeyById(key.id);
      expect(fetched).toBeNull();
    });

    it('should return false for non-existent key', () => {
      const deleted = ingestKeysDAL.deleteIngestKey('ik_nonexistent');
      expect(deleted).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // DAL: scopes
  // ═══════════════════════════════════════════════════════════════

  describe('scopes', () => {
    it('should default to ["map"] when no scopes provided', () => {
      const { key } = ingestKeysDAL.createIngestKey(agentId, {
        label: 'default-scope',
        agent_id: agentId,
      });

      expect(key.scopes).toEqual(['map']);
    });

    it('should store custom scopes', () => {
      const { key } = ingestKeysDAL.createIngestKey(agentId, {
        label: 'map-only',
        agent_id: agentId,
        scopes: ['map', 'sessions'],
      });

      expect(key.scopes).toEqual(['map', 'sessions']);
    });

    it('should persist scopes through validate', () => {
      const { plaintext_key } = ingestKeysDAL.createIngestKey(agentId, {
        label: 'scope-validate',
        agent_id: agentId,
        scopes: ['map'],
      });

      const validated = ingestKeysDAL.validateIngestKey(plaintext_key);
      expect(validated).not.toBeNull();
      expect(validated!.scopes).toEqual(['map']);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Admin Routes
  // ═══════════════════════════════════════════════════════════════

  describe('Admin Routes', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      const config = createTestConfig();
      app = await createTestApp(config);
    });

    afterAll(async () => {
      await app.close();
    });

    it('POST /admin/ingest-keys should create a key with explicit agent_id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ingest-keys',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { label: 'route-test', agent_id: agentId },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.key).toMatch(/^ohk_/);
      expect(body.label).toBe('route-test');
      expect(body.agent_id).toBe(agentId);
      expect(body.id).toMatch(/^ik_/);
    });

    it('POST /admin/ingest-keys should auto-create agent when agent_id omitted', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ingest-keys',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { label: 'auto-agent' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.key).toMatch(/^ohk_/);

      // Verify the auto-created agent exists
      const agent = agentsDAL.findAgentById(body.agent_id);
      expect(agent).not.toBeNull();
      expect(agent!.name).toBe('ingest-auto-agent');
    });

    it('POST /admin/ingest-keys should return 400 without label', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ingest-keys',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('POST /admin/ingest-keys should return 404 for non-existent agent_id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ingest-keys',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { label: 'bad-agent', agent_id: 'nonexistent' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('GET /admin/ingest-keys should list keys', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/ingest-keys',
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);

      // Should include key (plaintext) but NOT key_hash
      for (const k of body.data) {
        expect(k.key_hash).toBeUndefined();
        expect(k.key).toMatch(/^ohk_/);
        expect(k.id).toBeTruthy();
        expect(k.label).toBeTruthy();
      }
    });

    it('POST /admin/ingest-keys/:id/revoke should revoke a key', async () => {
      // Create a key to revoke
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ingest-keys',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { label: 'to-revoke', agent_id: agentId },
      });
      const keyId = createRes.json().id;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/ingest-keys/${keyId}/revoke`,
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      // Verify it's revoked
      const fetched = ingestKeysDAL.findIngestKeyById(keyId);
      expect(fetched!.revoked).toBe(true);
    });

    it('DELETE /admin/ingest-keys/:id should hard-delete a key', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ingest-keys',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { label: 'to-delete', agent_id: agentId },
      });
      const keyId = createRes.json().id;

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/ingest-keys/${keyId}`,
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      expect(res.statusCode).toBe(204);

      const fetched = ingestKeysDAL.findIngestKeyById(keyId);
      expect(fetched).toBeNull();
    });

    it('should require admin auth for all ingest key routes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/ingest-keys',
        // No admin key header
      });

      // Without admin key, should fall through to agent auth → 401
      expect(res.statusCode).toBe(401);
    });

    it('POST /admin/ingest-keys should accept scopes', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ingest-keys',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { label: 'scoped-key', agent_id: agentId, scopes: ['map', 'sessions'] },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.scopes).toEqual(['map', 'sessions']);
    });

    it('POST /admin/ingest-keys should reject invalid scopes', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ingest-keys',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { label: 'bad-scope', agent_id: agentId, scopes: ['invalid'] },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Auth Middleware Integration
  // ═══════════════════════════════════════════════════════════════

  describe('Auth Middleware', () => {
    let app: FastifyInstance;
    let validKey: string;
    let revokedKey: string;
    let expiredKey: string;

    beforeAll(async () => {
      const config = createTestConfig();
      app = await createTestApp(config);

      // Valid key with map+sessions scopes
      const validResult = ingestKeysDAL.createIngestKey(agentId, {
        label: 'auth-valid',
        agent_id: agentId,
        scopes: ['map', 'sessions'],
      });
      validKey = validResult.plaintext_key;

      // Revoked key
      const revokedResult = ingestKeysDAL.createIngestKey(agentId, {
        label: 'auth-revoked',
        agent_id: agentId,
        scopes: ['*'],
      });
      revokedKey = revokedResult.plaintext_key;
      ingestKeysDAL.revokeIngestKey(revokedResult.key.id);

      // Expired key
      const expiredResult = ingestKeysDAL.createIngestKey(agentId, {
        label: 'auth-expired',
        agent_id: agentId,
        scopes: ['*'],
        expires_in_hours: -1,
      });
      expiredKey = expiredResult.plaintext_key;
    });

    afterAll(async () => {
      await app.close();
    });

    // Use auth-required endpoints (authMiddleware, not optionalAuthMiddleware)
    // POST /sessions/upload and POST /sessions/detect-format both require authMiddleware

    it('should authenticate with a valid ingest key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/detect-format',
        headers: { authorization: `Bearer ${validKey}` },
        payload: { content: '{"type":"user","content":"hi"}' },
      });

      // Should not be 401 or 403 — the request made it past auth
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
    });

    it('should return 401 for a revoked ingest key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/detect-format',
        headers: { authorization: `Bearer ${revokedKey}` },
        payload: { content: '{}' },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('Invalid or expired ingest key');
    });

    it('should return 401 for an expired ingest key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/detect-format',
        headers: { authorization: `Bearer ${expiredKey}` },
        payload: { content: '{}' },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('Invalid or expired ingest key');
    });

    it('should return 401 for a non-existent ingest key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/detect-format',
        headers: { authorization: 'Bearer ohk_doesnotexist123456789012345678' },
        payload: { content: '{}' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('should not try bcrypt auth for ohk_ prefixed tokens', async () => {
      // An ohk_ token that doesn't exist should return 401 immediately,
      // not fall through to the slower bcrypt check
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/detect-format',
        headers: { authorization: 'Bearer ohk_invalid' },
        payload: { content: '{}' },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('Invalid or expired ingest key');
    });

    it('should return 401 with no auth header', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/upload',
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('Missing Authorization header');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Scope Enforcement
  // ═══════════════════════════════════════════════════════════════

  describe('Scope Enforcement', () => {
    let app: FastifyInstance;
    let mapKey: string;
    let sessionsKey: string;
    let resourcesKey: string;
    let multiKey: string;
    let fullKey: string;

    beforeAll(async () => {
      const config = createTestConfig();
      app = await createTestApp(config);

      const makeKey = (label: string, scopes: ingestKeysDAL.CreateIngestKeyInput['scopes']) => {
        const result = ingestKeysDAL.createIngestKey(agentId, {
          label,
          agent_id: agentId,
          scopes,
        });
        return result.plaintext_key;
      };

      mapKey = makeKey('scope-map', ['map']);
      sessionsKey = makeKey('scope-sessions', ['sessions']);
      resourcesKey = makeKey('scope-resources', ['resources']);
      multiKey = makeKey('scope-multi', ['map', 'sessions']);
      fullKey = makeKey('scope-full', ['*']);
    });

    afterAll(async () => {
      await app.close();
    });

    // ── map scope ──

    it('should allow map-scoped key to access /map/* endpoints', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/map/stats',
        headers: { authorization: `Bearer ${mapKey}` },
      });

      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
    });

    it('should block map-scoped key from /sessions/upload', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/upload',
        headers: { authorization: `Bearer ${mapKey}` },
        payload: {},
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().message).toContain("'sessions' scope");
    });

    it('should block map-scoped key from /resources', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/resources',
        headers: { authorization: `Bearer ${mapKey}` },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().message).toContain("'resources' scope");
    });

    // ── sessions scope ──

    it('should allow sessions-scoped key to access /sessions/upload', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/upload',
        headers: { authorization: `Bearer ${sessionsKey}` },
        payload: { name: 'test', content: '{}' },
      });

      // Should not be 403 (may be 400 for bad payload, that's fine)
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
    });

    it('should block sessions-scoped key from /map/* auth-required endpoints', async () => {
      // PUT /map/swarms/:id requires authMiddleware
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/map/swarms/fake-id',
        headers: { authorization: `Bearer ${sessionsKey}` },
        payload: {},
      });

      expect(res.statusCode).toBe(403);
    });

    // ── resources scope ──

    it('should allow resources-scoped key to access /resources', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/resources',
        headers: { authorization: `Bearer ${resourcesKey}` },
      });

      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
    });

    it('should block resources-scoped key from /map/*', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/map/swarms/fake-id',
        headers: { authorization: `Bearer ${resourcesKey}` },
        payload: {},
      });

      expect(res.statusCode).toBe(403);
    });

    // ── multi-scope key ──

    it('should allow multi-scope key to access both granted scopes', async () => {
      // map scope
      const mapRes = await app.inject({
        method: 'GET',
        url: '/api/v1/map/stats',
        headers: { authorization: `Bearer ${multiKey}` },
      });
      expect(mapRes.statusCode).not.toBe(401);
      expect(mapRes.statusCode).not.toBe(403);

      // sessions scope
      const sessRes = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/upload',
        headers: { authorization: `Bearer ${multiKey}` },
        payload: { name: 'test', content: '{}' },
      });
      expect(sessRes.statusCode).not.toBe(401);
      expect(sessRes.statusCode).not.toBe(403);
    });

    it('should block multi-scope key from non-granted scopes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/resources',
        headers: { authorization: `Bearer ${multiKey}` },
      });

      expect(res.statusCode).toBe(403);
    });

    // ── wildcard scope ──

    it('should allow wildcard key to access any endpoint', async () => {
      const endpoints = [
        { method: 'GET' as const, url: '/api/v1/map/stats' },
        { method: 'POST' as const, url: '/api/v1/sessions/upload' },
        { method: 'GET' as const, url: '/api/v1/resources' },
      ];

      for (const ep of endpoints) {
        const res = await app.inject({
          ...ep,
          headers: { authorization: `Bearer ${fullKey}` },
          ...(ep.method === 'POST' ? { payload: { name: 'test', content: '{}' } } : {}),
        });

        expect(res.statusCode).not.toBe(401);
        expect(res.statusCode).not.toBe(403);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Admin Route Filtering
  // ═══════════════════════════════════════════════════════════════

  describe('Admin Route Filtering', () => {
    let app: FastifyInstance;
    let secondAgentId: string;

    beforeAll(async () => {
      const config = createTestConfig();
      app = await createTestApp(config);

      const { agent } = await agentsDAL.createAgent({
        name: 'ingest-filter-agent',
        description: 'Second agent for filter tests',
      });
      secondAgentId = agent.id;

      // Create keys for both agents
      await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ingest-keys',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { label: 'filter-a', agent_id: agentId },
      });
      await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ingest-keys',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { label: 'filter-b', agent_id: secondAgentId },
      });
    });

    afterAll(async () => {
      await app.close();
    });

    it('GET /admin/ingest-keys?agent_id= should filter by agent', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/ingest-keys?agent_id=${secondAgentId}`,
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.length).toBeGreaterThan(0);
      for (const k of body.data) {
        expect(k.agent_id).toBe(secondAgentId);
      }
    });

    it('GET /admin/ingest-keys?include_revoked=true should include revoked keys', async () => {
      // Create and revoke a key
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ingest-keys',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { label: 'will-revoke', agent_id: agentId },
      });
      const keyId = createRes.json().id;
      await app.inject({
        method: 'POST',
        url: `/api/v1/admin/ingest-keys/${keyId}/revoke`,
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      // Without include_revoked — should not include the revoked key
      const res1 = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/ingest-keys',
        headers: { 'x-admin-key': ADMIN_KEY },
      });
      const ids1 = res1.json().data.map((k: { id: string }) => k.id);
      expect(ids1).not.toContain(keyId);

      // With include_revoked=true
      const res2 = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/ingest-keys?include_revoked=true',
        headers: { 'x-admin-key': ADMIN_KEY },
      });
      const ids2 = res2.json().data.map((k: { id: string }) => k.id);
      expect(ids2).toContain(keyId);
    });

    it('POST /admin/ingest-keys/:id/revoke should 404 for non-existent key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ingest-keys/ik_nonexistent/revoke',
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      expect(res.statusCode).toBe(404);
    });

    it('DELETE /admin/ingest-keys/:id should 404 for non-existent key', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/admin/ingest-keys/ik_nonexistent',
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      expect(res.statusCode).toBe(404);
    });

    it('POST /admin/ingest-keys should use custom agent_name for auto-created agent', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ingest-keys',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { label: 'named-agent', agent_name: 'my-custom-bot' },
      });

      expect(res.statusCode).toBe(201);
      const agent = agentsDAL.findAgentById(res.json().agent_id);
      expect(agent!.name).toBe('my-custom-bot');
    });

    it('POST /admin/ingest-keys should reuse existing agent by name', async () => {
      // Create two keys with the same agent_name — second should reuse the agent
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ingest-keys',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { label: 'reuse-1', agent_name: 'reusable-bot' },
      });
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ingest-keys',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { label: 'reuse-2', agent_name: 'reusable-bot' },
      });

      expect(res1.statusCode).toBe(201);
      expect(res2.statusCode).toBe(201);
      expect(res1.json().agent_id).toBe(res2.json().agent_id);
    });
  });
});

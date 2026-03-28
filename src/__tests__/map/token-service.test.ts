/**
 * Tests for MAP token-service (agent-iam TokenService singleton).
 *
 * Covers:
 *   - Initialization with explicit secret
 *   - Secret auto-generation and persistence
 *   - Token creation, verification, and delegation
 *   - Error handling for uninitialized service and invalid tokens
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { generateSecret } from 'agent-iam';
import {
  initTokenService,
  getTokenService,
  createSwarmToken,
  verifyToken,
  delegateToken,
  revokeToken,
  isTokenRevoked,
  unrevokeToken,
  loadRevocations,
  setPersistence,
  _resetTokenService,
} from '../../map/token-service.js';
import { testRoot, testDbPath, cleanTestRoot, mkTestDir } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('token-service');

beforeEach(() => {
  _resetTokenService();
});

afterAll(() => {
  cleanTestRoot(TEST_ROOT);
});

// ============================================================================
// Initialization
// ============================================================================

describe('token-service — initialization', () => {
  it('initializes with an explicit hex secret', () => {
    const secret = generateSecret().toString('hex');
    const ts = initTokenService(secret);
    expect(ts).toBeDefined();
  });

  it('returns the same instance on repeated init', () => {
    const secret = generateSecret().toString('hex');
    const ts1 = initTokenService(secret);
    const ts2 = initTokenService('different-secret-should-be-ignored');
    expect(ts1).toBe(ts2);
  });

  it('auto-generates and persists a secret when none provided', () => {
    const dataDir = mkTestDir(TEST_ROOT, 'auto-gen');
    fs.mkdirSync(path.join(dataDir, 'data'), { recursive: true });

    const ts = initTokenService(undefined, dataDir);
    expect(ts).toBeDefined();

    const secretPath = path.join(dataDir, 'data', 'iam-secret.key');
    expect(fs.existsSync(secretPath)).toBe(true);

    const persisted = fs.readFileSync(secretPath, 'utf-8').trim();
    expect(persisted).toMatch(/^[0-9a-f]{64}$/); // 32-byte hex
  });

  it('loads a persisted secret from disk', () => {
    const dataDir = mkTestDir(TEST_ROOT, 'load-secret');
    const secretDir = path.join(dataDir, 'data');
    fs.mkdirSync(secretDir, { recursive: true });

    const secret = generateSecret();
    fs.writeFileSync(path.join(secretDir, 'iam-secret.key'), secret.toString('hex'));

    const ts = initTokenService(undefined, dataDir);
    expect(ts).toBeDefined();

    // Verify the loaded secret works (create + verify round-trip)
    const { serialized } = createSwarmToken('test-swarm');
    const result = verifyToken(serialized);
    expect(result.valid).toBe(true);
  });

  it('throws when getTokenService is called before init', () => {
    expect(() => getTokenService()).toThrow('TokenService not initialized');
  });
});

// ============================================================================
// Token creation and verification
// ============================================================================

describe('token-service — create and verify', () => {
  beforeEach(() => {
    _resetTokenService();
    initTokenService(generateSecret().toString('hex'));
  });

  it('creates a root token for a swarm', () => {
    const { token, serialized } = createSwarmToken('swarm-abc');
    expect(token.agentId).toBe('swarm-abc');
    expect(token.scopes).toContain('map:*');
    expect(serialized).toBeTruthy();
    expect(typeof serialized).toBe('string');
  });

  it('creates a token with custom scopes and TTL', () => {
    const { token } = createSwarmToken('swarm-xyz', {
      scopes: ['map:observe:*', 'map:message:*'],
      ttlDays: 7,
    });
    expect(token.scopes).toEqual(['map:observe:*', 'map:message:*']);
  });

  it('verifies a valid token', () => {
    const { serialized } = createSwarmToken('swarm-verify');
    const result = verifyToken(serialized);
    expect(result.valid).toBe(true);
    expect(result.token).toBeDefined();
    expect(result.token!.agentId).toBe('swarm-verify');
  });

  it('rejects a tampered token', () => {
    const { serialized } = createSwarmToken('swarm-tamper');
    // Corrupt the token by flipping a character
    const corrupted = serialized.slice(0, -2) + 'XX';
    const result = verifyToken(corrupted);
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects a token signed with a different secret', () => {
    const { serialized } = createSwarmToken('swarm-wrong-key');

    // Reset and init with a different secret
    _resetTokenService();
    initTokenService(generateSecret().toString('hex'));

    const result = verifyToken(serialized);
    expect(result.valid).toBe(false);
  });

  it('rejects garbage input', () => {
    const result = verifyToken('not-a-valid-token');
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// ============================================================================
// Token delegation
// ============================================================================

describe('token-service — delegation', () => {
  beforeEach(() => {
    _resetTokenService();
    initTokenService(generateSecret().toString('hex'));
  });

  it('delegates a child token from a parent', () => {
    const { serialized: parentSerialized } = createSwarmToken('parent-agent');
    const { token: child, serialized: childSerialized } = delegateToken(parentSerialized, {
      agentId: 'child-agent',
      ttlMinutes: 30,
    });

    expect(child.agentId).toBe('child-agent');
    expect(childSerialized).toBeTruthy();

    // Child token should verify
    const result = verifyToken(childSerialized);
    expect(result.valid).toBe(true);
    expect(result.token!.agentId).toBe('child-agent');
  });

  it('delegates with narrower scopes', () => {
    const { serialized: parentSerialized } = createSwarmToken('parent-scoped');
    const { token: child } = delegateToken(parentSerialized, {
      agentId: 'child-scoped',
      scopes: ['map:observe:*'],
    });

    expect(child.scopes).toEqual(['map:observe:*']);
  });

  it('child token has incremented delegation depth', () => {
    const { serialized: parentSerialized } = createSwarmToken('parent-depth');
    const { token: child } = delegateToken(parentSerialized, {
      agentId: 'child-depth',
    });

    expect(child.currentDepth).toBeGreaterThan(0);
  });
});

// ============================================================================
// Token revocation
// ============================================================================

describe('token-service — revocation', () => {
  beforeEach(() => {
    _resetTokenService();
    initTokenService(generateSecret().toString('hex'));
  });

  it('revokes a token by agent ID', () => {
    const { serialized } = createSwarmToken('revoke-me');

    // Valid before revocation
    expect(verifyToken(serialized).valid).toBe(true);

    revokeToken('revoke-me');

    // Rejected after revocation
    const result = verifyToken(serialized);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('revoked');
  });

  it('tracks revocation status', () => {
    expect(isTokenRevoked('some-swarm')).toBe(false);
    revokeToken('some-swarm');
    expect(isTokenRevoked('some-swarm')).toBe(true);
  });

  it('un-revokes a token', () => {
    const { serialized } = createSwarmToken('temp-revoke');
    revokeToken('temp-revoke');
    expect(verifyToken(serialized).valid).toBe(false);

    unrevokeToken('temp-revoke');
    expect(verifyToken(serialized).valid).toBe(true);
  });

  it('revocation does not affect other swarms', () => {
    const { serialized: s1 } = createSwarmToken('swarm-a');
    const { serialized: s2 } = createSwarmToken('swarm-b');

    revokeToken('swarm-a');

    expect(verifyToken(s1).valid).toBe(false);
    expect(verifyToken(s2).valid).toBe(true);
  });
});

// ============================================================================
// Token expiry
// ============================================================================

describe('token-service — token expiry fields', () => {
  beforeEach(() => {
    _resetTokenService();
    initTokenService(generateSecret().toString('hex'));
  });

  it('token has expiresAt field set', () => {
    const { token } = createSwarmToken('expiry-test', { ttlDays: 1 });
    expect(token.expiresAt).toBeDefined();
    // expiresAt should be in the future
    const expiresAt = new Date(token.expiresAt!).getTime();
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it('expiry time is approximately correct for given TTL', () => {
    const { token } = createSwarmToken('expiry-ttl', { ttlDays: 7 });
    const expiresAt = new Date(token.expiresAt!).getTime();
    const expectedMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
    // Allow 10 seconds of tolerance
    expect(Math.abs(expiresAt - expectedMs)).toBeLessThan(10_000);
  });
});

// ============================================================================
// loadRevocations (pre-seeding)
// ============================================================================

describe('token-service — loadRevocations', () => {
  beforeEach(() => {
    _resetTokenService();
    initTokenService(generateSecret().toString('hex'));
  });

  it('pre-loads revocations into the in-memory set', () => {
    const { serialized } = createSwarmToken('preloaded-revoke');

    // Before loading, token is valid
    expect(verifyToken(serialized).valid).toBe(true);

    // Load revocations as if from the database
    loadRevocations(['preloaded-revoke']);

    // Now token should be rejected
    const result = verifyToken(serialized);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('revoked');
  });

  it('loadRevocations does not duplicate entries', () => {
    loadRevocations(['dup-agent', 'dup-agent']);
    expect(isTokenRevoked('dup-agent')).toBe(true);

    // Unrevoking once should clear it
    unrevokeToken('dup-agent');
    expect(isTokenRevoked('dup-agent')).toBe(false);
  });
});

// ============================================================================
// Persistent revocation (with real DB)
// ============================================================================

describe('token-service — persistent revocation', () => {
  const dbRoot = testRoot('token-svc-revoke-db');
  let addRevokedToken: (id: string, reason?: string) => void;
  let removeRevokedToken: (id: string) => void;
  let listRevokedTokens: () => string[];

  beforeEach(async () => {
    _resetTokenService();
    initTokenService(generateSecret().toString('hex'));

    // Initialize a real DB for persistence tests
    const { initDatabase } = await import('../../db/index.js');
    const dbPath = testDbPath(dbRoot, `revoke-${Date.now()}.db`);
    initDatabase(dbPath);

    // Wire up persistence (same as server.ts does)
    const dal = await import('../../db/dal/map.js');
    addRevokedToken = dal.addRevokedToken;
    removeRevokedToken = dal.removeRevokedToken;
    listRevokedTokens = dal.listRevokedTokens;
    setPersistence({ revoke: addRevokedToken, unrevoke: removeRevokedToken });
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../../db/index.js');
    closeDatabase();
  });

  afterAll(() => {
    cleanTestRoot(dbRoot);
  });

  it('persists revocation to the database', () => {
    revokeToken('persist-swarm', 'compromised');

    const revoked = listRevokedTokens();
    expect(revoked).toContain('persist-swarm');
  });

  it('removes revocation from the database on unrevoke', () => {
    revokeToken('unrevoke-swarm');
    unrevokeToken('unrevoke-swarm');

    const revoked = listRevokedTokens();
    expect(revoked).not.toContain('unrevoke-swarm');
  });

  it('survives reset + loadRevocations round-trip (simulates restart)', () => {
    revokeToken('roundtrip-swarm');

    // Verify it's in the DB
    expect(listRevokedTokens()).toContain('roundtrip-swarm');

    // Simulate restart: reset in-memory state
    _resetTokenService();
    initTokenService(generateSecret().toString('hex'));

    // In-memory set is cleared
    expect(isTokenRevoked('roundtrip-swarm')).toBe(false);

    // Reload from DB (same as server.ts startup)
    loadRevocations(listRevokedTokens());

    // Now it's back
    expect(isTokenRevoked('roundtrip-swarm')).toBe(true);
  });
});

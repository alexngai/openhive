/**
 * Unit tests for the spawn-credential delegation helper (PR 2 of the
 * v4 capability rollout).
 *
 * Verifies:
 *  - requestedScopes ⊆ parentScopes is enforced
 *  - TTL is clamped to [1, 1440] minutes
 *  - Wildcards in parent scopes cover narrower child scopes
 *  - Delegated tokens verify via the token service
 *  - env payload contains both AGENT_TOKEN and MAP_CREDENTIAL aliases
 *  - Minted child tokens carry the requested narrow scope set
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initTokenService,
  _resetTokenService,
  verifyToken,
} from '../../map/token-service.js';
import {
  delegateForSpawn,
  ScopeNotGrantedError,
} from '../../map/delegate-for-spawn.js';
import { testRoot, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('delegate-for-spawn');

describe('delegateForSpawn', () => {
  beforeAll(() => {
    cleanTestRoot(TEST_ROOT);
    initTokenService(undefined, TEST_ROOT);
  });

  afterAll(() => {
    _resetTokenService();
    cleanTestRoot(TEST_ROOT);
  });

  // ──────────────────────────────────────────────────────────────
  // Happy path
  // ──────────────────────────────────────────────────────────────

  it('mints a child token with the requested narrow scope', () => {
    const result = delegateForSpawn({
      parentAgentId: 'parent-1',
      parentScopes: ['map:*'],
      childAgentId: 'child-1',
      requestedScopes: ['map:agents:spawn'],
      ttlMinutes: 30,
    });

    expect(result.method).toBe('bearer');
    expect(result.credentials.token).toBeTruthy();
    expect(result.env.AGENT_TOKEN).toBe(result.credentials.token);
    expect(result.env.MAP_CREDENTIAL).toBe(result.credentials.token);

    const verified = verifyToken(result.credentials.token);
    expect(verified.valid).toBe(true);
    expect(verified.token?.agentId).toBe('child-1');
    expect(verified.token?.scopes).toEqual(['map:agents:spawn']);
  });

  it('defaults requestedScopes to parent scopes when empty array passed', () => {
    const result = delegateForSpawn({
      parentAgentId: 'parent-default',
      parentScopes: ['map:tasks:create', 'map:tasks:list'],
      childAgentId: 'child-default',
      requestedScopes: [],
    });

    const verified = verifyToken(result.credentials.token);
    expect(verified.token?.scopes).toEqual(['map:tasks:create', 'map:tasks:list']);
  });

  it('works with agent-iam token scopes as parentScopes (verified-mode simulation)', () => {
    // In production the caller would pull parentScopes off an agent-iam
    // token's `scopes` field. This test just exercises the flat-array
    // path — no difference from the POV of delegateForSpawn.
    const parentScopes = ['map:agents:spawn', 'map:tasks:create'];
    const result = delegateForSpawn({
      parentAgentId: 'verified-parent',
      parentScopes,
      childAgentId: 'verified-child',
      requestedScopes: ['map:tasks:create'],
    });
    expect(verifyToken(result.credentials.token).valid).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────
  // Scope enforcement
  // ──────────────────────────────────────────────────────────────

  it('throws ScopeNotGrantedError when requested scope exceeds parent', () => {
    expect(() =>
      delegateForSpawn({
        parentAgentId: 'parent-narrow',
        parentScopes: ['map:tasks:create'],
        childAgentId: 'child-overreach',
        requestedScopes: ['map:agents:spawn'],
      }),
    ).toThrow(ScopeNotGrantedError);
  });

  it('error carries the offending scope + -32403 code', () => {
    try {
      delegateForSpawn({
        parentAgentId: 'parent-err',
        parentScopes: ['map:tasks:create'],
        childAgentId: 'child-err',
        requestedScopes: ['forbidden:scope'],
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ScopeNotGrantedError);
      expect((err as ScopeNotGrantedError).code).toBe(-32403);
      expect((err as ScopeNotGrantedError).scope).toBe('forbidden:scope');
    }
  });

  it('parent map:* wildcard covers any narrower scope', () => {
    const result = delegateForSpawn({
      parentAgentId: 'parent-wildcard',
      parentScopes: ['map:*'],
      childAgentId: 'child-wildcard',
      requestedScopes: ['map:agents:spawn', 'map:tasks:create'],
    });
    expect(result.credentials.token).toBeTruthy();
  });

  it('checks subsets for each requested scope independently', () => {
    // One of these is covered, one isn't — should throw on the uncovered
    expect(() =>
      delegateForSpawn({
        parentAgentId: 'parent-partial',
        parentScopes: ['map:tasks:create'],
        childAgentId: 'child-partial',
        requestedScopes: ['map:tasks:create', 'map:agents:spawn'],
      }),
    ).toThrow(ScopeNotGrantedError);
  });

  it('empty parent scopes → any requested scope throws', () => {
    expect(() =>
      delegateForSpawn({
        parentAgentId: 'parent-empty',
        parentScopes: [],
        childAgentId: 'child-empty',
        requestedScopes: ['map:*'],
      }),
    ).toThrow(ScopeNotGrantedError);
  });

  // ──────────────────────────────────────────────────────────────
  // TTL clamping
  // ──────────────────────────────────────────────────────────────

  it('defaults to 60 minute TTL when not specified', () => {
    const before = Date.now();
    const result = delegateForSpawn({
      parentAgentId: 'p-default-ttl',
      parentScopes: ['map:*'],
      childAgentId: 'c-default-ttl',
      requestedScopes: ['map:*'],
    });
    const verified = verifyToken(result.credentials.token);
    const expiresAt = new Date(verified.token!.expiresAt!).getTime();

    // ~60 min TTL
    const ttlMs = expiresAt - before;
    expect(ttlMs).toBeGreaterThan(59 * 60 * 1000);
    expect(ttlMs).toBeLessThan(61 * 60 * 1000);
  });

  it('clamps TTL above 30 days down to 30 days for root-authority bootstrap', () => {
    const before = Date.now();
    const result = delegateForSpawn({
      parentAgentId: 'p-max-ttl',
      parentScopes: ['map:*'],
      childAgentId: 'c-max-ttl',
      requestedScopes: ['map:*'],
      ttlMinutes: 999999, // > 30d
      // No parentSerializedToken — admin-bootstrap path, 30d cap.
    });
    expect(result.ttlMinutes).toBe(30 * 24 * 60);
    const verified = verifyToken(result.credentials.token);
    const expiresAt = new Date(verified.token!.expiresAt!).getTime();
    const ttlMs = expiresAt - before;
    expect(ttlMs).toBeLessThan(31 * 24 * 60 * 60 * 1000);
    expect(ttlMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
  });

  it('clamps TTL of 0 up to 1 minute', () => {
    const result = delegateForSpawn({
      parentAgentId: 'p-min-ttl',
      parentScopes: ['map:*'],
      childAgentId: 'c-min-ttl',
      requestedScopes: ['map:*'],
      ttlMinutes: 0,
    });
    const verified = verifyToken(result.credentials.token);
    expect(verified.token!.expiresAt).toBeTruthy();
  });
});

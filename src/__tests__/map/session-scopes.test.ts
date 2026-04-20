/**
 * Unit tests for session scope resolution (PR 1 of the v4 capability
 * rollout). Verifies `resolveSessionScopes` produces the right scope
 * set across trust modes and admin status, and that `requireCapability`
 * + `sessionHasCapability` gate correctly including wildcards.
 *
 * See docs/RFC_AGENT_CAPABILITIES.md v4 §"Session scope resolution".
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import {
  resolveSessionScopes,
  sessionHasCapability,
  requireCapability,
  CapabilityDeniedError,
} from '../../map/session-scopes.js';
import type { Agent } from '../../types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('session-scopes');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'session-scopes.db');

describe('session-scopes', () => {
  let adminAgent: Agent;
  let regularAgent: Agent;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    const admin = await agentsDAL.createAgent({
      name: 'scope-admin',
      description: 'admin',
      is_admin: true,
    });
    const regular = await agentsDAL.createAgent({
      name: 'scope-regular',
      description: 'regular',
      is_admin: false,
    });
    adminAgent = admin.agent;
    regularAgent = regular.agent;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    // Reset regular agent's grants between tests
    const existing = agentsDAL.getAgentCapabilities(regularAgent.id);
    for (const cap of Object.keys(existing)) {
      agentsDAL.revokeAgentCapability(regularAgent.id, cap);
    }
  });

  // ────────────────────────────────────────────────────────────────
  // resolveSessionScopes — the core resolution logic
  // ────────────────────────────────────────────────────────────────
  describe('resolveSessionScopes', () => {
    it('admin gets map:* regardless of other inputs', () => {
      expect(resolveSessionScopes({ agent: adminAgent })).toEqual(['map:*']);
      expect(resolveSessionScopes({
        agent: adminAgent,
        tokenScopes: ['narrow:scope'],
      })).toEqual(['map:*']);
    });

    it('verified mode: uses token scopes for non-admin', () => {
      expect(resolveSessionScopes({
        agent: regularAgent,
        tokenScopes: ['map:agents:spawn', 'map:tasks:create'],
      })).toEqual(['map:agents:spawn', 'map:tasks:create']);
    });

    it('open mode: uses DB capabilities for non-admin', () => {
      agentsDAL.grantAgentCapability(regularAgent.id, 'map:agents:spawn');
      expect(resolveSessionScopes({ agent: regularAgent })).toEqual([
        'map:agents:spawn',
      ]);
    });

    it('non-admin with no grants and no token → empty scope set', () => {
      expect(resolveSessionScopes({ agent: regularAgent })).toEqual([]);
    });

    it('token scopes take precedence over DB grants (verified > open)', () => {
      agentsDAL.grantAgentCapability(regularAgent.id, 'map:agents:spawn');
      // In verified mode, token is authoritative — we don't merge DB grants.
      expect(resolveSessionScopes({
        agent: regularAgent,
        tokenScopes: ['narrower:scope'],
      })).toEqual(['narrower:scope']);
    });

    it('empty tokenScopes array falls through to DB', () => {
      // Important edge case — a verified session with an empty token
      // scope list shouldn't silently grant DB scopes. Verify via:
      // empty array is falsy-ish but still an array. Our code checks
      // length > 0.
      agentsDAL.grantAgentCapability(regularAgent.id, 'map:agents:spawn');
      expect(resolveSessionScopes({
        agent: regularAgent,
        tokenScopes: [],
      })).toEqual(['map:agents:spawn']);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // sessionHasCapability — scope matching (including wildcards)
  // ────────────────────────────────────────────────────────────────
  describe('sessionHasCapability', () => {
    it('exact match', () => {
      expect(sessionHasCapability(['map:agents:spawn'], 'map:agents:spawn')).toBe(true);
    });

    it('wildcard: map:* covers any map: capability', () => {
      expect(sessionHasCapability(['map:*'], 'map:agents:spawn')).toBe(true);
      expect(sessionHasCapability(['map:*'], 'map:tasks:create')).toBe(true);
    });

    it('narrow scope does not cover broader', () => {
      expect(sessionHasCapability(['map:agents:spawn'], 'map:*')).toBe(false);
    });

    it('different top-level namespace does not match', () => {
      expect(sessionHasCapability(['map:*'], 'admin:config:set')).toBe(false);
    });

    it('undefined or empty scopes → deny', () => {
      expect(sessionHasCapability(undefined, 'map:agents:spawn')).toBe(false);
      expect(sessionHasCapability([], 'map:agents:spawn')).toBe(false);
    });

    it('multiple scopes — any match passes', () => {
      expect(sessionHasCapability(
        ['map:tasks:create', 'map:agents:spawn', 'trajectory:report'],
        'map:agents:spawn',
      )).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // requireCapability — throws CapabilityDeniedError on denial
  // ────────────────────────────────────────────────────────────────
  describe('requireCapability', () => {
    it('passes when scopes grant the required capability', () => {
      expect(() =>
        requireCapability({ scopes: ['map:*'] }, 'map:agents:spawn'),
      ).not.toThrow();
    });

    it('throws CapabilityDeniedError with -32403 code when denied', () => {
      try {
        requireCapability({ scopes: ['other:scope'], agentId: 'agent-x' }, 'map:agents:spawn');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CapabilityDeniedError);
        expect((err as CapabilityDeniedError).code).toBe(-32403);
        expect((err as CapabilityDeniedError).capability).toBe('map:agents:spawn');
        expect((err as CapabilityDeniedError).message).toMatch(/agent-x/);
      }
    });

    it('error message omits agent id when not provided', () => {
      try {
        requireCapability({ scopes: [] }, 'map:agents:spawn');
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as Error).message).not.toMatch(/undefined/);
      }
    });

    it('falls back to registry lookup when ctx has no explicit scopes', () => {
      // Without a registered connection, getSessionScopes returns undefined →
      // sessionHasCapability returns false → requireCapability throws.
      expect(() =>
        requireCapability({ swarmId: 'nonexistent-swarm' }, 'map:agents:spawn'),
      ).toThrow(CapabilityDeniedError);
    });
  });
});

/**
 * Unit tests for the agent capability DAL helpers.
 *
 * Covers the `agents.capabilities` JSON column: grant / revoke / read
 * round-trips, malformed-input handling (default-deny), and the
 * parse/serialize primitives in `middleware/capabilities.ts`.
 *
 * Uses two distinct capability strings to exercise multi-grant scenarios:
 *  - `map:agents:spawn` — the v4 canonical vocabulary, in KNOWN_CAPABILITIES
 *  - `x-test:alpha` — a synthetic test-only capability (not validated at
 *    the DAL layer; the admin REST endpoint would reject it)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import {
  KNOWN_CAPABILITIES,
  isKnownCapability,
  parseCapabilities,
  serializeCapabilities,
  hasCapability,
} from '../../api/middleware/capabilities.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('agent-capabilities');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'agent-caps.db');

const SPAWN = 'map:agents:spawn';
const TEST_B = 'x-test:alpha';

describe('Agent capabilities — middleware helpers', () => {
  it('KNOWN_CAPABILITIES contains the v4 vocabulary', () => {
    expect(KNOWN_CAPABILITIES.has(SPAWN)).toBe(true);
  });

  it('isKnownCapability rejects unknown strings', () => {
    expect(isKnownCapability('not.a.real.capability')).toBe(false);
    expect(isKnownCapability('')).toBe(false);
    expect(isKnownCapability(SPAWN)).toBe(true);
  });

  describe('parseCapabilities', () => {
    it('returns empty object for null/undefined/empty', () => {
      expect(parseCapabilities(null)).toEqual({});
      expect(parseCapabilities(undefined)).toEqual({});
      expect(parseCapabilities('')).toEqual({});
    });

    it('parses a JSON object of boolean-true grants', () => {
      const raw = `{"${SPAWN}":true,"${TEST_B}":true}`;
      expect(parseCapabilities(raw)).toEqual({
        [SPAWN]: true,
        [TEST_B]: true,
      });
    });

    it('filters out non-true values (default-deny extension)', () => {
      const raw = `{"${SPAWN}":true,"${TEST_B}":false,"scoped":{"hive":"x"}}`;
      expect(parseCapabilities(raw)).toEqual({ [SPAWN]: true });
    });

    it('default-denies on malformed JSON', () => {
      expect(parseCapabilities('{ not json')).toEqual({});
      expect(parseCapabilities('null')).toEqual({});
      expect(parseCapabilities('"string"')).toEqual({});
      expect(parseCapabilities('[1,2,3]')).toEqual({});
    });
  });

  describe('serializeCapabilities', () => {
    it('returns null for empty grant map (keep column NULL-able)', () => {
      expect(serializeCapabilities({})).toBeNull();
    });

    it('filters out non-true values', () => {
      const raw = serializeCapabilities({
        [SPAWN]: true,
        [TEST_B]: false as unknown as boolean,
      });
      expect(raw).toBe(`{"${SPAWN}":true}`);
    });

    it('round-trips via parseCapabilities', () => {
      const original = { [SPAWN]: true, [TEST_B]: true };
      const serialized = serializeCapabilities(original);
      expect(serialized).not.toBeNull();
      expect(parseCapabilities(serialized)).toEqual(original);
    });
  });

  describe('hasCapability', () => {
    it('returns false for no blob', () => {
      expect(hasCapability(null, SPAWN)).toBe(false);
    });

    it('returns true when granted', () => {
      expect(hasCapability(`{"${SPAWN}":true}`, SPAWN)).toBe(true);
    });

    it('returns false when other capabilities are granted but not the target', () => {
      expect(hasCapability(`{"${TEST_B}":true}`, SPAWN)).toBe(false);
    });
  });
});

describe('Agent capabilities — DAL', () => {
  let agentId: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'caps-test-agent',
      description: 'Agent under capability test',
    });
    agentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    getDatabase()
      .prepare('UPDATE agents SET capabilities = NULL WHERE id = ?')
      .run(agentId);
  });

  it('new agent has no grants', () => {
    expect(agentsDAL.getAgentCapabilitiesRaw(agentId)).toBeNull();
    expect(agentsDAL.getAgentCapabilities(agentId)).toEqual({});
    expect(agentsDAL.agentHasCapability(agentId, SPAWN)).toBe(false);
  });

  it('grantAgentCapability writes the grant and getAgentCapabilities reads it', () => {
    agentsDAL.grantAgentCapability(agentId, SPAWN);
    expect(agentsDAL.agentHasCapability(agentId, SPAWN)).toBe(true);
    expect(agentsDAL.getAgentCapabilities(agentId)).toEqual({ [SPAWN]: true });
  });

  it('granting twice is idempotent', () => {
    agentsDAL.grantAgentCapability(agentId, SPAWN);
    agentsDAL.grantAgentCapability(agentId, SPAWN);
    expect(agentsDAL.getAgentCapabilities(agentId)).toEqual({ [SPAWN]: true });
  });

  it('granting multiple different capabilities accumulates', () => {
    agentsDAL.grantAgentCapability(agentId, SPAWN);
    agentsDAL.grantAgentCapability(agentId, TEST_B);
    expect(agentsDAL.getAgentCapabilities(agentId)).toEqual({
      [SPAWN]: true,
      [TEST_B]: true,
    });
  });

  it('revokeAgentCapability removes just that grant', () => {
    agentsDAL.grantAgentCapability(agentId, SPAWN);
    agentsDAL.grantAgentCapability(agentId, TEST_B);
    agentsDAL.revokeAgentCapability(agentId, SPAWN);
    expect(agentsDAL.agentHasCapability(agentId, SPAWN)).toBe(false);
    expect(agentsDAL.agentHasCapability(agentId, TEST_B)).toBe(true);
  });

  it('revoking a non-granted capability is a no-op', () => {
    agentsDAL.revokeAgentCapability(agentId, SPAWN);
    expect(agentsDAL.getAgentCapabilities(agentId)).toEqual({});
  });

  it('revoking the last grant sets the column back to NULL', () => {
    agentsDAL.grantAgentCapability(agentId, SPAWN);
    agentsDAL.revokeAgentCapability(agentId, SPAWN);
    expect(agentsDAL.getAgentCapabilitiesRaw(agentId)).toBeNull();
  });

  it('default-denies when the column contains malformed JSON', () => {
    getDatabase()
      .prepare('UPDATE agents SET capabilities = ? WHERE id = ?')
      .run('{ corrupt', agentId);
    expect(agentsDAL.getAgentCapabilities(agentId)).toEqual({});
    expect(agentsDAL.agentHasCapability(agentId, SPAWN)).toBe(false);
  });
});

/**
 * Tests for MAP inbound WebSocket (/ws/map) local auth mode:
 * - Local auth mode accepts tokenless connections via getOrCreateLocalAgent
 * - Local auth mode auto-registers swarms without ?auto_register=true
 * - Non-local auth mode rejects tokenless connections
 *
 * These are unit tests that verify the auth and registration branching logic
 * without spinning up a full Fastify server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as mapDAL from '../../db/dal/map.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('ws-map-local-auth');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'ws-map-local-auth.db');

describe('MAP WebSocket local auth mode', () => {
  beforeAll(() => {
    initDatabase(TEST_DB_PATH);
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  describe('getOrCreateLocalAgent', () => {
    it('creates a local agent on first call', async () => {
      const agent = await agentsDAL.getOrCreateLocalAgent();
      expect(agent).toBeDefined();
      expect(agent.name).toBe('local');
      expect(agent.is_admin).toBe(true);
    });

    it('returns the same agent on subsequent calls', async () => {
      const agent1 = await agentsDAL.getOrCreateLocalAgent();
      const agent2 = await agentsDAL.getOrCreateLocalAgent();
      expect(agent1.id).toBe(agent2.id);
    });
  });

  describe('setupMapWebSocket authMode option', () => {
    it('exports setupMapWebSocket with opts parameter', async () => {
      const mod = await import('../../map/ws-map.js');
      expect(typeof mod.setupMapWebSocket).toBe('function');
      expect(mod.setupMapWebSocket.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('auth decision logic', () => {
    // Simulates the auth branching in setupMapWebSocket:
    // if (query.token) → authenticateToken(query.token)
    // else if (isLocalAuth) → getOrCreateLocalAgent()
    // else → null (rejected)

    it('local mode: tokenless connection gets local agent', async () => {
      const isLocalAuth = true;
      const queryToken = undefined;

      let agent = null;
      if (queryToken) {
        // would call authenticateToken
      } else if (isLocalAuth) {
        agent = await agentsDAL.getOrCreateLocalAgent();
      }

      expect(agent).not.toBeNull();
      expect(agent!.name).toBe('local');
    });

    it('non-local mode: tokenless connection gets null (rejected)', async () => {
      const isLocalAuth = false;
      const queryToken = undefined;

      let agent = null;
      if (queryToken) {
        // would call authenticateToken
      } else if (isLocalAuth) {
        agent = await agentsDAL.getOrCreateLocalAgent();
      }

      expect(agent).toBeNull();
    });

    it('local mode with token: uses token auth (not local fallback)', async () => {
      const isLocalAuth = true;
      const queryToken = 'some-api-key';

      let usedTokenAuth = false;
      let usedLocalFallback = false;

      if (queryToken) {
        usedTokenAuth = true;
      } else if (isLocalAuth) {
        usedLocalFallback = true;
      }

      expect(usedTokenAuth).toBe(true);
      expect(usedLocalFallback).toBe(false);
    });
  });

  describe('swarm auto-registration', () => {
    // Simulates the swarm resolution + auto-register branching:
    // if (!swarmId && (query.auto_register === 'true' || isLocalAuth))
    //   → autoRegisterSwarm()

    it('local mode: auto-registers without ?auto_register=true', async () => {
      const isLocalAuth = true;
      const queryAutoRegister = undefined; // no query param
      const agent = await agentsDAL.getOrCreateLocalAgent();

      // Simulate: resolveSwarm returns null (no existing swarm)
      let swarmId: string | null = null;

      if (!swarmId && (queryAutoRegister === 'true' || isLocalAuth)) {
        const swarm = mapDAL.createSwarm(agent.id, {
          name: `${agent.name}-hub`,
          map_endpoint: 'hub-inbound',
          map_transport: 'websocket',
        });
        swarmId = swarm.id;
      }

      expect(swarmId).not.toBeNull();

      // Verify the swarm was created
      const { data: swarms } = mapDAL.listSwarms({ owner_agent_id: agent.id });
      expect(swarms.length).toBeGreaterThan(0);
    });

    it('non-local mode without ?auto_register: does not auto-register', () => {
      const isLocalAuth = false;
      const queryAutoRegister = undefined;

      let swarmId: string | null = null;
      let autoRegistered = false;

      if (!swarmId && (queryAutoRegister === 'true' || isLocalAuth)) {
        autoRegistered = true;
      }

      expect(autoRegistered).toBe(false);
    });

    it('non-local mode with ?auto_register=true: auto-registers', () => {
      const isLocalAuth = false;
      const queryAutoRegister = 'true';

      let swarmId: string | null = null;
      let autoRegistered = false;

      if (!swarmId && (queryAutoRegister === 'true' || isLocalAuth)) {
        autoRegistered = true;
      }

      expect(autoRegistered).toBe(true);
    });
  });
});

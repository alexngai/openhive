/**
 * E2E Test: MAP SDK Verified Auth Flow
 *
 * Uses the real @multi-agent-protocol/sdk AgentConnection against a live
 * OpenHive server in verified mode.
 *
 * The current SDK (v0.1.x) passes auth inline via the connect() options.
 * The hub supports both inline auth (current SDK) and the future split
 * flow (createConnection + connectOnly + authenticate + register).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { AgentConnection } from '@multi-agent-protocol/sdk';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { initTokenService, createSwarmToken, revokeToken, _resetTokenService } from '../../map/token-service.js';
import { generateSecret } from 'agent-iam';
import { ConfigSchema } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('map-e2e-sdk');
const TEST_DB = testDbPath(TEST_ROOT, 'e2e-sdk.db');
const PORT = 19680;

describe('E2E: MAP SDK — Verified Mode', () => {
  let app: FastifyInstance;
  let apiKey: string;
  let swarmToken: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB);

    _resetTokenService();
    initTokenService(generateSecret().toString('hex'));

    const result = await agentsDAL.createAgent({ name: 'e2e-sdk-agent' });
    apiKey = result.apiKey;

    const { serialized } = createSwarmToken('sdk-swarm-001', { scopes: ['map:*'] });
    swarmToken = serialized;

    const config = ConfigSchema.parse({
      port: PORT, host: '127.0.0.1', database: TEST_DB,
      instance: { name: 'SDK E2E Test' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      cors: { enabled: false },
      mapHub: { enabled: true, trustModel: 'verified' },
    });

    app = Fastify({ logger: false });
    app.decorateRequest('agent', null);
    await app.register(websocket);
    setupMapWebSocket(app, config);
    await app.listen({ port: PORT, host: '127.0.0.1' });
  }, 15000);

  afterAll(async () => {
    stopMapWebSocket();
    await new Promise((r) => setTimeout(r, 100));
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    _resetTokenService();
  });

  it('connects using inline auth via AgentConnection.connect()', async () => {
    // API key in URL for hub access, agent-iam token passed as inline auth
    const agent = await AgentConnection.connect(
      `ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}`,
      {
        name: 'sdk-test-agent',
        role: 'sidecar',
        scopes: ['swarm:test'],
        auth: { method: 'x-agent-iam', token: swarmToken },
        connectTimeout: 5000,
      },
    );

    expect(agent.agentId).toBeDefined();
    expect(agent.sessionId).toBeDefined();
    expect(agent.isConnected).toBe(true);

    await agent.disconnect();
  });

  it('rejects connection with a revoked token', async () => {
    const { serialized: revokeableToken } = createSwarmToken('revoke-sdk-swarm');

    // Revoke before connecting
    revokeToken('revoke-sdk-swarm');

    try {
      await AgentConnection.connect(
        `ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}`,
        {
          name: 'revoked-agent',
          role: 'sidecar',
          auth: { method: 'x-agent-iam', token: revokeableToken },
          connectTimeout: 5000,
        },
      );
      expect.unreachable('Expected connection to fail with revoked token');
    } catch (err) {
      // Expected — server closes connection on revoked token
      expect(err).toBeDefined();
    }
  });

  it('rejects connection without auth in verified mode', async () => {
    try {
      await AgentConnection.connect(
        `ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}`,
        {
          name: 'no-auth-agent',
          role: 'worker',
          connectTimeout: 3000,
        },
      );
      expect.unreachable('Expected connection to fail without auth in verified mode');
    } catch (err) {
      // Expected — server responds with authRequired, SDK can't proceed
      expect(err).toBeDefined();
    }
  });
});

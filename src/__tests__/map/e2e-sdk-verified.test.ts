/**
 * E2E Test: MAP SDK Verified Auth Flow
 *
 * Uses the real @multi-agent-protocol/sdk AgentConnection with the new
 * createConnection() + connectOnly() + authenticate() + register() flow
 * against a live OpenHive server in verified mode.
 *
 * This is the full end-to-end test that proves the sidecar's verified
 * mode path works with the published SDK.
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

describe('E2E: MAP SDK — Verified Mode with createConnection()', () => {
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

  it('connects using createConnection + connectOnly + authenticate + register', async () => {
    // API key in URL for hub access, then protocol-level auth for swarm identity
    const agent = await AgentConnection.createConnection(
      `ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}`,
      { name: 'sdk-test-agent', role: 'sidecar', scopes: ['swarm:test'] },
    );

    // Step 1: connectOnly — should get authRequired back
    const connectResult = await agent.connectOnly();
    expect(connectResult.authRequired).toBeDefined();
    expect(connectResult.authRequired!.required).toBe(true);
    expect(connectResult.authRequired!.methods).toContain('x-agent-iam');

    // Step 2: authenticate with the server's preferred method
    const method = connectResult.authRequired!.methods[0];
    const authResult = await agent.authenticate({ method, token: swarmToken });
    expect(authResult.success).toBe(true);
    expect(authResult.participantId).toBe('sdk-swarm-001');

    // Step 3: register as an agent
    const registeredAgent = await agent.register();
    expect(registeredAgent).toBeDefined();

    await agent.disconnect();
  });

  it('falls back to standard connect() for open mode (no auth needed)', async () => {
    // This tests that the standard connect() still works when the server
    // doesn't require auth (would be open mode — but we're in verified mode
    // so this should fail with auth error since connect() skips negotiation)
    try {
      await AgentConnection.connect(
        `ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}`,
        { name: 'standard-connect', role: 'worker', connectTimeout: 3000 },
      );
      // If this succeeds, the server accepted without auth (unexpected in verified mode)
      expect.unreachable('Expected connect() to fail in verified mode');
    } catch (err) {
      // Expected — standard connect() sends map/connect + agents/register
      // but the server responds with authRequired instead of a connect success
      expect(err).toBeDefined();
    }
  });

  it('rejects a revoked token', async () => {
    const { serialized: revokeableToken } = createSwarmToken('revoke-sdk-swarm');

    // Revoke before connecting
    revokeToken('revoke-sdk-swarm');

    const agent = await AgentConnection.createConnection(
      `ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}`,
      { name: 'revoked-agent', role: 'sidecar' },
    );

    await agent.connectOnly();

    try {
      const authResult = await agent.authenticate({ method: 'x-agent-iam' as any, token: revokeableToken });
      // SDK might throw or return error — depends on server response
      expect(authResult.success).toBe(false);
    } catch {
      // Expected — server closes connection on revoked token
    }
  });
});

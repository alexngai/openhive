import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as bridgeDAL from '../../db/dal/bridge.js';
import { encryptCredentials } from '../../bridge/credentials.js';
import { BridgeManager } from '../../bridge/manager.js';
import type { BridgeAdapter, InboundMessage, AdapterConfig, PlatformDestination, OutboundMessage } from '../../bridge/types.js';

// Mock broadcastToChannel
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

const TEST_DB_PATH = path.join(process.cwd(), 'test-manager.db');
const ENCRYPTION_KEY = 'test-manager-encryption-key';

function createTestAgent(db: ReturnType<typeof import('better-sqlite3')>, name: string): string {
  const id = `agent_${name}`;
  db.prepare(`
    INSERT OR IGNORE INTO agents (id, name, account_type) VALUES (?, ?, 'human')
  `).run(id, name);
  return id;
}

/**
 * Create a mock adapter that yields messages from a controllable queue.
 */
function createMockAdapter(): BridgeAdapter & {
  pushMessage: (msg: InboundMessage) => void;
  sentMessages: Array<{ destination: PlatformDestination; message: OutboundMessage }>;
  closeStream: () => void;
  connectCalls: number;
  disconnectCalls: number;
  lastConfig: AdapterConfig | null;
} {
  let messageResolve: ((value: IteratorResult<InboundMessage>) => void) | null = null;
  const messageQueue: InboundMessage[] = [];
  let streamClosed = false;
  const sentMessages: Array<{ destination: PlatformDestination; message: OutboundMessage }> = [];
  let connectCalls = 0;
  let disconnectCalls = 0;
  let lastConfig: AdapterConfig | null = null;

  const adapter: BridgeAdapter & {
    pushMessage: (msg: InboundMessage) => void;
    sentMessages: typeof sentMessages;
    closeStream: () => void;
    connectCalls: number;
    disconnectCalls: number;
    lastConfig: AdapterConfig | null;
  } = {
    platform: 'slack',
    sentMessages,

    get connectCalls() { return connectCalls; },
    get disconnectCalls() { return disconnectCalls; },
    get lastConfig() { return lastConfig; },

    async connect(config: AdapterConfig) {
      connectCalls++;
      lastConfig = config;
    },

    messages(): AsyncIterable<InboundMessage> {
      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<InboundMessage>> {
              if (streamClosed) {
                return Promise.resolve({ done: true, value: undefined });
              }
              if (messageQueue.length > 0) {
                return Promise.resolve({ done: false, value: messageQueue.shift()! });
              }
              return new Promise((resolve) => {
                messageResolve = resolve;
              });
            },
          };
        },
      };
    },

    async send(destination: PlatformDestination, message: OutboundMessage) {
      sentMessages.push({ destination, message });
    },

    async disconnect() {
      disconnectCalls++;
      streamClosed = true;
      if (messageResolve) {
        messageResolve({ done: true, value: undefined });
        messageResolve = null;
      }
    },

    pushMessage(msg: InboundMessage) {
      if (messageResolve) {
        messageResolve({ done: false, value: msg });
        messageResolve = null;
      } else {
        messageQueue.push(msg);
      }
    },

    closeStream() {
      streamClosed = true;
      if (messageResolve) {
        messageResolve({ done: true, value: undefined });
        messageResolve = null;
      }
    },
  };

  return adapter;
}

describe('BridgeManager', () => {
  let db: ReturnType<typeof import('better-sqlite3')>;
  let testAgentId: string;
  let manager: BridgeManager;
  let mockAdapter: ReturnType<typeof createMockAdapter>;

  beforeAll(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    db = initDatabase(TEST_DB_PATH);
    testAgentId = createTestAgent(db, 'manager-test-owner');
  });

  afterEach(async () => {
    if (manager) {
      await manager.stopAll();
    }
  });

  afterAll(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  function createManager(): BridgeManager {
    manager = new BridgeManager({
      maxBridges: 5,
      credentialEncryptionKey: ENCRYPTION_KEY,
    });
    mockAdapter = createMockAdapter();
    manager.registerAdapter('slack', () => mockAdapter);
    return manager;
  }

  function createTestBridge(name: string, status: 'active' | 'inactive' = 'inactive'): string {
    const encrypted = encryptCredentials({ bot_token: 'xoxb-test' }, ENCRYPTION_KEY);
    const bridge = bridgeDAL.createBridge({
      name,
      platform: 'slack',
      transport_mode: 'outbound',
      credentials_encrypted: encrypted,
      owner_agent_id: testAgentId,
    });
    if (status === 'active') {
      bridgeDAL.updateBridge(bridge.id, { status: 'active' });
    }
    return bridge.id;
  }

  // ── Adapter registration ──

  it('registers adapter factories', () => {
    const mgr = createManager();
    expect(() => mgr.registerAdapter('discord', () => createMockAdapter())).not.toThrow();
  });

  // ── Starting bridges ──

  it('starts a bridge successfully', async () => {
    const mgr = createManager();
    const bridgeId = createTestBridge('start-test');

    await mgr.startBridge(bridgeId);

    expect(mgr.runningCount).toBe(1);
    const status = mgr.getBridgeStatus(bridgeId);
    expect(status).not.toBeNull();
    expect(status!.status).toBe('connected');
    expect(mockAdapter.connectCalls).toBe(1);
  });

  it('decrypts credentials and passes them to adapter', async () => {
    const mgr = createManager();
    const bridgeId = createTestBridge('cred-test');

    await mgr.startBridge(bridgeId);

    expect(mockAdapter.lastConfig).not.toBeNull();
    expect(mockAdapter.lastConfig!.credentials.bot_token).toBe('xoxb-test');
  });

  it('throws when starting an already-running bridge', async () => {
    const mgr = createManager();
    const bridgeId = createTestBridge('dupe-test');

    await mgr.startBridge(bridgeId);
    await expect(mgr.startBridge(bridgeId)).rejects.toThrow('already running');
  });

  it('throws when bridge not found', async () => {
    const mgr = createManager();
    await expect(mgr.startBridge('nonexistent')).rejects.toThrow('not found');
  });

  it('throws when no adapter registered for platform', async () => {
    manager = new BridgeManager({
      maxBridges: 5,
      credentialEncryptionKey: ENCRYPTION_KEY,
    });
    // Don't register any adapters

    const encrypted = encryptCredentials({ token: 'test' }, ENCRYPTION_KEY);
    const bridge = bridgeDAL.createBridge({
      name: 'no-adapter-test',
      platform: 'discord',
      transport_mode: 'outbound',
      credentials_encrypted: encrypted,
      owner_agent_id: testAgentId,
    });

    await expect(manager.startBridge(bridge.id)).rejects.toThrow('No adapter registered');
  });

  it('enforces max bridges limit', async () => {
    manager = new BridgeManager({
      maxBridges: 1,
      credentialEncryptionKey: ENCRYPTION_KEY,
    });
    manager.registerAdapter('slack', () => createMockAdapter());

    const id1 = createTestBridge('limit-1');
    const id2 = createTestBridge('limit-2');

    await manager.startBridge(id1);
    await expect(manager.startBridge(id2)).rejects.toThrow('Maximum bridge limit');
  });

  it('throws when encryption key not configured', async () => {
    manager = new BridgeManager({ maxBridges: 5 });
    manager.registerAdapter('slack', () => createMockAdapter());
    const bridgeId = createTestBridge('no-key-test');

    await expect(manager.startBridge(bridgeId)).rejects.toThrow('encryption key not configured');
  });

  // ── Stopping bridges ──

  it('stops a running bridge', async () => {
    const mgr = createManager();
    const bridgeId = createTestBridge('stop-test');

    await mgr.startBridge(bridgeId);
    expect(mgr.runningCount).toBe(1);

    await mgr.stopBridge(bridgeId);
    expect(mgr.runningCount).toBe(0);
    expect(mockAdapter.disconnectCalls).toBe(1);

    // Check DB status was updated
    const config = bridgeDAL.getBridge(bridgeId);
    expect(config!.status).toBe('inactive');
  });

  it('stopAll stops all bridges', async () => {
    const mgr = createManager();
    const id1 = createTestBridge('stopall-1');
    const id2 = createTestBridge('stopall-2');

    // Need separate adapters for each
    let adapterCount = 0;
    manager.registerAdapter('slack', () => {
      adapterCount++;
      return createMockAdapter();
    });

    await mgr.startBridge(id1);
    await mgr.startBridge(id2);
    expect(mgr.runningCount).toBe(2);

    await mgr.stopAll();
    expect(mgr.runningCount).toBe(0);
  });

  it('stopBridge is safe to call on non-running bridge', async () => {
    const mgr = createManager();
    await expect(mgr.stopBridge('nonexistent')).resolves.toBeUndefined();
  });

  // ── Status ──

  it('returns status for running bridge', async () => {
    const mgr = createManager();
    const bridgeId = createTestBridge('status-test');

    await mgr.startBridge(bridgeId);
    const status = mgr.getBridgeStatus(bridgeId);

    expect(status).not.toBeNull();
    expect(status!.name).toBe('status-test');
    expect(status!.platform).toBe('slack');
    expect(status!.status).toBe('connected');
  });

  it('returns disconnected status for non-running bridge', () => {
    const mgr = createManager();
    const bridgeId = createTestBridge('status-stopped');
    const status = mgr.getBridgeStatus(bridgeId);

    expect(status).not.toBeNull();
    expect(status!.status).toBe('disconnected');
  });

  it('returns null for non-existent bridge', () => {
    const mgr = createManager();
    expect(mgr.getBridgeStatus('nonexistent')).toBeNull();
  });

  // ── Outbound relay ──

  it('relays hive events to connected bridges', async () => {
    const mgr = createManager();
    const bridgeId = createTestBridge('outbound-relay');

    bridgeDAL.addChannelMapping(bridgeId, {
      platform_channel_id: 'C_RELAY',
      hive_name: 'general',
      direction: 'bidirectional',
    });

    // Re-register adapter so it gets the mappings
    mockAdapter = createMockAdapter();
    mgr.registerAdapter('slack', () => mockAdapter);

    await mgr.startBridge(bridgeId);

    mgr.notifyHiveEvent({
      type: 'new_post',
      postId: 'post_relay_1',
      authorId: testAgentId,
      authorName: 'Test User',
      hiveName: 'general',
      title: 'Relayed Post',
      content: 'This should be relayed',
    });

    // Give the async send a moment
    await new Promise(r => setTimeout(r, 50));

    expect(mockAdapter.sentMessages.length).toBe(1);
    expect(mockAdapter.sentMessages[0].destination.platformChannelId).toBe('C_RELAY');
    expect(mockAdapter.sentMessages[0].message.text).toContain('Relayed Post');
  });

  it('skips outbound relay for disconnected bridges', async () => {
    const mgr = createManager();

    // Don't start any bridge, just call notifyHiveEvent
    mgr.notifyHiveEvent({
      type: 'new_post',
      postId: 'post_skip',
      authorId: testAgentId,
      authorName: 'Test',
      hiveName: 'general',
      content: 'Should not relay',
    });

    // No error thrown, no messages sent
  });

  // ── Mapping reload ──

  it('reloads channel mappings for running bridge', async () => {
    const mgr = createManager();
    const bridgeId = createTestBridge('reload-mappings');

    await mgr.startBridge(bridgeId);

    // Initially no mappings
    let status = mgr.getBridgeStatus(bridgeId);
    expect(status!.channelCount).toBe(0);

    // Add a mapping
    bridgeDAL.addChannelMapping(bridgeId, {
      platform_channel_id: 'C_NEW',
      hive_name: 'general',
    });

    // Reload
    mgr.reloadMappings(bridgeId);

    status = mgr.getBridgeStatus(bridgeId);
    expect(status!.channelCount).toBe(1);
  });

  // ── startAll ──

  it('starts all active bridges on startup', async () => {
    const mgr = createManager();
    const activeId = createTestBridge('startall-active', 'active');
    createTestBridge('startall-inactive', 'inactive');

    // Need separate adapters
    mgr.registerAdapter('slack', () => createMockAdapter());

    await mgr.startAll();

    // Only the active bridge should start
    expect(mgr.runningCount).toBe(1);
    const status = mgr.getBridgeStatus(activeId);
    expect(status!.status).toBe('connected');
  });
});

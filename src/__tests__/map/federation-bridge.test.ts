/**
 * Tests for Sync Federation Bridge — gateway creation, push routing,
 * inbound event handling, status reporting, and cleanup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockHubPeer = {
  server: { fake: 'server' },
  send: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../map/mesh-peer.js', () => ({
  isMeshEnabled: vi.fn(() => true),
  getHubMeshPeer: vi.fn(() => mockHubPeer),
}));

const mockChannel = {
  recordReceived: vi.fn(),
  recordSent: vi.fn(),
};

vi.mock('../../map/mesh-channels.js', () => ({
  getChannel: vi.fn(() => mockChannel),
}));

function createMockGateway() {
  const handlers = new Map<string, Function>();
  return {
    on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)),
    route: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    bufferedMessageCount: 0,
    _handlers: handlers,
  };
}

let mockGateway = createMockGateway();

vi.mock('agentic-mesh', () => ({
  createFederationGateway: vi.fn(() => mockGateway),
}));

// ---------------------------------------------------------------------------
// Imports (must come after vi.mock calls)
// ---------------------------------------------------------------------------

import {
  onInboundSyncEvents,
  createSyncGateway,
  pushViaGateway,
  hasGateway,
  getGatewayStatus,
  closeAllGateways,
  type SyncGatewayConfig,
} from '../../sync/federation-bridge.js';

import { isMeshEnabled } from '../../map/mesh-peer.js';
import { getChannel } from '../../map/mesh-channels.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultConfig: SyncGatewayConfig = {
  localSystemId: 'local-sys-1',
  remoteSystemId: 'remote-sys-1',
  remoteMeshPeerId: 'peer-abc',
  syncToken: 'tok-123',
};

function makeSyncEvents(count = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id: `evt-${i}`,
    event_type: 'post:created',
    origin_instance_id: 'inst-1',
    origin_ts: new Date().toISOString(),
    payload: { title: `Post ${i}` },
    signature: 'sig',
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sync Federation Bridge', () => {
  beforeEach(async () => {
    mockGateway = createMockGateway();
    const agenticMesh = await import('agentic-mesh') as any;
    vi.mocked(agenticMesh.createFederationGateway).mockReturnValue(mockGateway as any);
    vi.mocked(isMeshEnabled).mockReturnValue(true);
    vi.mocked(getChannel).mockReturnValue(mockChannel as any);
    mockHubPeer.send.mockReset();
    mockChannel.recordReceived.mockReset();
    mockChannel.recordSent.mockReset();
  });

  afterEach(async () => {
    await closeAllGateways();
  });

  // -----------------------------------------------------------------------
  // createSyncGateway
  // -----------------------------------------------------------------------

  it('should return false when mesh is disabled', async () => {
    vi.mocked(isMeshEnabled).mockReturnValue(false);
    const result = await createSyncGateway(defaultConfig);
    expect(result).toBe(false);
    expect(hasGateway('peer-abc')).toBe(false);
  });

  it('should return false when agentic-mesh import fails', async () => {
    const agenticMesh = await import('agentic-mesh') as any;
    vi.mocked(agenticMesh.createFederationGateway).mockImplementation(() => {
      throw new Error('module not found');
    });

    const result = await createSyncGateway(defaultConfig);
    expect(result).toBe(false);
  });

  it('should create a gateway and register it in the registry', async () => {
    const result = await createSyncGateway(defaultConfig);

    expect(result).toBe(true);
    expect(hasGateway('peer-abc')).toBe(true);
    expect(mockGateway.on).toHaveBeenCalledWith('message:received', expect.any(Function));
    expect(mockGateway.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mockGateway.on).toHaveBeenCalledWith('connected', expect.any(Function));
    expect(mockGateway.on).toHaveBeenCalledWith('disconnected', expect.any(Function));
  });

  it('should handle connected/disconnected events and update status', async () => {
    await createSyncGateway(defaultConfig);

    // Initially not connected
    expect(getGatewayStatus('peer-abc')?.connected).toBe(false);

    // Simulate connected event
    mockGateway._handlers.get('connected')!();
    expect(getGatewayStatus('peer-abc')?.connected).toBe(true);

    // Simulate disconnected event
    mockGateway._handlers.get('disconnected')!();
    expect(getGatewayStatus('peer-abc')?.connected).toBe(false);
  });

  // -----------------------------------------------------------------------
  // onInboundSyncEvents
  // -----------------------------------------------------------------------

  it('should invoke registered inbound handler on message:received', async () => {
    const handler = vi.fn();
    onInboundSyncEvents(handler);
    await createSyncGateway(defaultConfig);

    const envelope = {
      payload: {
        events: [{ id: 'e1' }],
        sender_seq: 42,
        trace_id: 'trace-1',
      },
    };

    mockGateway._handlers.get('message:received')!(envelope);

    expect(handler).toHaveBeenCalledWith([{ id: 'e1' }], 42, 'trace-1');
    expect(mockChannel.recordReceived).toHaveBeenCalledWith(envelope, 'peer-abc');
  });

  it('should handle envelope without payload wrapper gracefully', async () => {
    const handler = vi.fn();
    onInboundSyncEvents(handler);
    await createSyncGateway(defaultConfig);

    // envelope with no payload — falls back to defaults
    mockGateway._handlers.get('message:received')!({});

    expect(handler).toHaveBeenCalledWith([], 0, '');
  });

  // -----------------------------------------------------------------------
  // pushViaGateway
  // -----------------------------------------------------------------------

  it('should return false when no gateway exists for the peer', async () => {
    const result = await pushViaGateway('unknown-peer', makeSyncEvents(), 1, 'trace-x');
    expect(result).toBe(false);
  });

  it('should route events via gateway.route and record stats', async () => {
    await createSyncGateway(defaultConfig);

    const events = makeSyncEvents(2);
    const result = await pushViaGateway('peer-abc', events, 5, 'trace-2');

    expect(result).toBe(true);
    expect(mockGateway.route).toHaveBeenCalledWith(
      {
        jsonrpc: '2.0',
        method: 'sync/push',
        params: { events, sender_seq: 5, trace_id: 'trace-2' },
      },
      [],
    );
    expect(mockChannel.recordSent).toHaveBeenCalled();
  });

  it('should fall back to hubPeer.send when gateway.route is not a function', async () => {
    // Remove route from the mock gateway
    (mockGateway as any).route = undefined;
    await createSyncGateway(defaultConfig);

    const events = makeSyncEvents();
    const result = await pushViaGateway('peer-abc', events, 1, 'trace-fb');

    expect(result).toBe(true);
    expect(mockHubPeer.send).toHaveBeenCalledWith(
      'openhive-hub',
      'peer-abc',
      expect.objectContaining({ method: 'sync/push' }),
    );
  });

  it('should return false when gateway.route throws', async () => {
    mockGateway.route.mockRejectedValueOnce(new Error('route failed'));
    await createSyncGateway(defaultConfig);

    const result = await pushViaGateway('peer-abc', makeSyncEvents(), 1, 'trace-err');
    expect(result).toBe(false);
  });

  // -----------------------------------------------------------------------
  // getGatewayStatus / hasGateway
  // -----------------------------------------------------------------------

  it('should return null for unknown peer status', () => {
    expect(getGatewayStatus('nonexistent')).toBeNull();
  });

  it('should report buffered message count from the gateway', async () => {
    mockGateway.bufferedMessageCount = 7;
    await createSyncGateway(defaultConfig);

    const status = getGatewayStatus('peer-abc');
    expect(status).toEqual({ connected: false, buffered: 7 });
  });

  // -----------------------------------------------------------------------
  // closeAllGateways
  // -----------------------------------------------------------------------

  it('should disconnect all gateways and clear the registry', async () => {
    await createSyncGateway(defaultConfig);
    await createSyncGateway({
      ...defaultConfig,
      remoteMeshPeerId: 'peer-def',
      remoteSystemId: 'remote-sys-2',
    });

    expect(hasGateway('peer-abc')).toBe(true);
    expect(hasGateway('peer-def')).toBe(true);

    await closeAllGateways();

    expect(hasGateway('peer-abc')).toBe(false);
    expect(hasGateway('peer-def')).toBe(false);
  });
});

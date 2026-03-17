import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';

import {
  registerInbound,
  unregisterInbound,
  getInbound,
  getAllInbound,
  getInboundCount,
  sendToInbound,
  initMeshPeerRef,
  type MapInboundConnection,
} from '../../map/connection-registry.js';

function createMockWs(): WebSocket {
  const ws = new EventEmitter() as unknown as WebSocket;
  (ws as unknown as { readyState: number }).readyState = 1; // OPEN
  (ws as unknown as { send: Function }).send = vi.fn();
  (ws as unknown as { close: Function }).close = vi.fn();
  return ws;
}

function makeConn(
  swarmId: string,
  transport: MapInboundConnection['transport'],
): MapInboundConnection {
  return {
    transport,
    agentId: `agent-${swarmId}`,
    swarmId,
    connectedAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
  };
}

describe('connection-registry', () => {
  // Clean up all connections between tests
  beforeEach(() => {
    for (const key of getAllInbound().keys()) {
      unregisterInbound(key);
    }
  });

  afterEach(() => {
    for (const key of getAllInbound().keys()) {
      unregisterInbound(key);
    }
    vi.restoreAllMocks();
  });

  // ── register / get ──────────────────────────────────────────────────

  it('registerInbound stores connection and getInbound retrieves it', () => {
    const ws = createMockWs();
    const conn = makeConn('swarm-1', { type: 'websocket', ws });

    registerInbound('swarm-1', conn);

    expect(getInbound('swarm-1')).toBe(conn);
  });

  it('registerInbound replaces existing connection and closes old WebSocket', () => {
    const oldWs = createMockWs();
    const oldConn = makeConn('swarm-1', { type: 'websocket', ws: oldWs });
    registerInbound('swarm-1', oldConn);

    const newWs = createMockWs();
    const newConn = makeConn('swarm-1', { type: 'websocket', ws: newWs });
    registerInbound('swarm-1', newConn);

    expect(getInbound('swarm-1')).toBe(newConn);
    expect(oldWs.close).toHaveBeenCalled();
    expect(newWs.close).not.toHaveBeenCalled();
  });

  // ── unregister ──────────────────────────────────────────────────────

  it('unregisterInbound removes connection', () => {
    const ws = createMockWs();
    const conn = makeConn('swarm-1', { type: 'websocket', ws });
    registerInbound('swarm-1', conn);

    unregisterInbound('swarm-1');

    expect(getInbound('swarm-1')).toBeUndefined();
  });

  // ── getAllInbound / getInboundCount ─────────────────────────────────

  it('getAllInbound returns the full map', () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    registerInbound('swarm-a', makeConn('swarm-a', { type: 'websocket', ws: ws1 }));
    registerInbound('swarm-b', makeConn('swarm-b', { type: 'websocket', ws: ws2 }));

    const all = getAllInbound();
    expect(all.size).toBe(2);
    expect(all.has('swarm-a')).toBe(true);
    expect(all.has('swarm-b')).toBe(true);
  });

  it('getInboundCount returns correct count', () => {
    expect(getInboundCount()).toBe(0);

    registerInbound('s1', makeConn('s1', { type: 'websocket', ws: createMockWs() }));
    expect(getInboundCount()).toBe(1);

    registerInbound('s2', makeConn('s2', { type: 'websocket', ws: createMockWs() }));
    expect(getInboundCount()).toBe(2);

    unregisterInbound('s1');
    expect(getInboundCount()).toBe(1);
  });

  // ── sendToInbound: WebSocket transport ─────────────────────────────

  it('sendToInbound via WebSocket sends JSON when ws is OPEN', () => {
    const ws = createMockWs();
    registerInbound('swarm-1', makeConn('swarm-1', { type: 'websocket', ws }));

    const msg = { jsonrpc: '2.0', method: 'ping' };
    const result = sendToInbound('swarm-1', msg);

    expect(result).toBe(true);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(msg));
  });

  it('sendToInbound via WebSocket returns false when ws is not OPEN', () => {
    const ws = createMockWs();
    (ws as unknown as { readyState: number }).readyState = 3; // CLOSED
    registerInbound('swarm-1', makeConn('swarm-1', { type: 'websocket', ws }));

    const result = sendToInbound('swarm-1', { jsonrpc: '2.0', method: 'ping' });

    expect(result).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  // ── sendToInbound: unknown swarm ───────────────────────────────────

  it('sendToInbound returns false for unknown swarm', () => {
    const result = sendToInbound('no-such-swarm', { test: true });
    expect(result).toBe(false);
  });

  // ── sendToInbound: mesh transport ──────────────────────────────────

  it('sendToInbound via mesh returns true when mesh module loaded and enabled', async () => {
    const mockSend = vi.fn().mockResolvedValue(undefined);
    const meshModule = {
      isMeshEnabled: () => true,
      getHubMeshPeer: () => ({ send: mockSend }),
    };

    vi.doMock('../../map/mesh-peer.js', () => meshModule);

    // Re-import to get fresh module state with the mock in place
    const { registerInbound: reg, sendToInbound: send, initMeshPeerRef: init } =
      await import('../../map/connection-registry.js');

    // Trigger lazy load of mesh-peer module
    init();
    // Allow the dynamic import promise to resolve
    await vi.dynamicImportSettled?.() ?? new Promise(r => setTimeout(r, 50));

    reg('mesh-swarm', makeConn('mesh-swarm', { type: 'mesh', peerId: 'peer-123' }));

    const result = send('mesh-swarm', { jsonrpc: '2.0', method: 'hello' });
    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledWith(
      'openhive-hub',
      'peer-123',
      { jsonrpc: '2.0', method: 'hello' },
    );

    vi.doUnmock('../../map/mesh-peer.js');
  });

  it('sendToInbound via mesh returns false when mesh module not loaded yet', () => {
    // Use the original (non-mocked) module — _meshPeerModule starts as null.
    // Register a mesh connection in the shared registry (which the original module uses).
    registerInbound('mesh-swarm-2', makeConn('mesh-swarm-2', { type: 'mesh', peerId: 'peer-456' }));

    // On a fresh process _meshPeerModule is null, so sendToInbound should return false
    // and fire-and-forget an import. The dynamic import will fail in test env, which is fine.
    const result = sendToInbound('mesh-swarm-2', { jsonrpc: '2.0', method: 'hello' });
    expect(result).toBe(false);
  });
});

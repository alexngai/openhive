/**
 * Verifies the server-side PTY→WebSocket output coalescing in
 * `handleTerminalWebSocket`. A single TUI redraw emits many small PTY
 * chunks; the handler must buffer them within a tick and flush ONE
 * WebSocket frame instead of one frame per chunk.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { handleTerminalWebSocket } from '../../terminal/terminal-ws.js';
import type { PtyManager } from '../../terminal/pty-manager.js';

/** Resolve after all pending `setImmediate` callbacks have run. */
const tick = () => new Promise<void>((r) => setImmediate(r));

interface FakeSocket {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

function makeSocket(): FakeSocket {
  return {
    readyState: 1, // WebSocket.OPEN
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  };
}

/** Minimal PtyManager stand-in: a real EventEmitter for `session.data`. */
function makePtyManager(): EventEmitter & Partial<PtyManager> {
  const pm = new EventEmitter() as EventEmitter & Partial<PtyManager>;
  pm.getInfo = vi.fn(() => ({ status: 'running' })) as unknown as PtyManager['getInfo'];
  pm.getRecentOutput = vi.fn(() => '') as unknown as PtyManager['getRecentOutput'];
  return pm;
}

/** Drop the synchronous `{type:'connected'}` (+ replay) frames. */
function clearHandshake(socket: FakeSocket) {
  socket.send.mockClear();
}

describe('terminal-ws output coalescing', () => {
  let socket: FakeSocket;
  let pm: EventEmitter & Partial<PtyManager>;

  beforeEach(async () => {
    socket = makeSocket();
    pm = makePtyManager();
    await handleTerminalWebSocket(
      socket as never,
      { sessionId: 's1' },
      pm as PtyManager,
    );
    clearHandshake(socket);
  });

  it('coalesces many same-tick PTY chunks into a single WS frame', async () => {
    pm.emit('session.data', { sessionId: 's1', data: 'a' });
    pm.emit('session.data', { sessionId: 's1', data: 'b' });
    pm.emit('session.data', { sessionId: 's1', data: 'c' });
    pm.emit('session.data', { sessionId: 's1', data: 'd' });
    pm.emit('session.data', { sessionId: 's1', data: 'e' });

    // Nothing flushed within the same tick — purely buffered.
    expect(socket.send).not.toHaveBeenCalled();

    await tick();

    // 5 chunks → exactly 1 frame carrying the concatenation.
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledWith('abcde');
  });

  it('preserves byte order and content across the buffer', async () => {
    const frame = 'a'.repeat(2000);
    for (let i = 0; i < 50; i++) {
      pm.emit('session.data', { sessionId: 's1', data: frame });
    }
    await tick();
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledWith(frame.repeat(50));
  });

  it('flushes separately across distinct ticks', async () => {
    pm.emit('session.data', { sessionId: 's1', data: 'first' });
    await tick();
    pm.emit('session.data', { sessionId: 's1', data: 'second' });
    await tick();

    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(socket.send).toHaveBeenNthCalledWith(1, 'first');
    expect(socket.send).toHaveBeenNthCalledWith(2, 'second');
  });

  it('ignores data for other sessions', async () => {
    pm.emit('session.data', { sessionId: 'other', data: 'nope' });
    pm.emit('session.data', { sessionId: 's1', data: 'yes' });
    await tick();
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledWith('yes');
  });

  it('does not send when the socket has closed before flush', async () => {
    pm.emit('session.data', { sessionId: 's1', data: 'buffered' });
    socket.readyState = 3; // WebSocket.CLOSED
    await tick();
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('speedup: frame count is independent of chunk count', async () => {
    // The whole point — N chunks must not produce N frames.
    const chunkCount = 200;
    for (let i = 0; i < chunkCount; i++) {
      pm.emit('session.data', { sessionId: 's1', data: `chunk${i};` });
    }
    await tick();
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.send.mock.calls[0][0]).toContain('chunk0;');
    expect(socket.send.mock.calls[0][0]).toContain(`chunk${chunkCount - 1};`);
  });
});

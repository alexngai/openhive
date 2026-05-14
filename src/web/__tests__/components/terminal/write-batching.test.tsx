/**
 * Verifies the client-side rAF write-batching in TerminalPanel. The server
 * sends many small frames per TUI redraw; the panel must coalesce them into
 * one `term.write()` per animation frame instead of one write per message.
 *
 * Control messages (`connected`, `exit`) and the exit path must still flush
 * synchronously so ordering holds.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TerminalPanel } from '../../../components/terminal/TerminalPanel';

// --- ghostty-web mock -------------------------------------------------------
// Shared spies so assertions can inspect the single Terminal instance the
// component creates per connect.
const { writeSpy, writelnSpy, disposeSpy } = vi.hoisted(() => ({
  writeSpy: vi.fn(),
  writelnSpy: vi.fn(),
  disposeSpy: vi.fn(),
}));

vi.mock('ghostty-web', () => {
  class FakeTerminal {
    cols = 80;
    rows = 24;
    write = writeSpy;
    writeln = writelnSpy;
    dispose = disposeSpy;
    loadAddon = vi.fn();
    open = vi.fn();
    onData = vi.fn();
    onResize = vi.fn();
    focus = vi.fn();
  }
  class FakeFitAddon {
    fit = vi.fn();
    observeResize = vi.fn();
  }
  return {
    init: vi.fn(() => Promise.resolve()),
    Terminal: FakeTerminal,
    FitAddon: FakeFitAddon,
  };
});

// api is imported by TerminalPanel but unused on the no-swarm shell path.
vi.mock('../../../lib/api', () => ({ api: { get: vi.fn() } }));
// Mouse bridge touches real DOM on the term element — stub it out.
vi.mock('../../../components/terminal/terminal-mouse', () => ({
  setupMouseBridge: vi.fn(() => vi.fn()),
}));

// --- WebSocket mock ---------------------------------------------------------
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 1;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
}

// --- requestAnimationFrame control -----------------------------------------
let rafCallbacks: Array<FrameRequestCallback | undefined> = [];
function flushRaf() {
  const cbs = rafCallbacks;
  rafCallbacks = [];
  cbs.forEach((cb) => cb?.(performance.now()));
}

beforeEach(() => {
  writeSpy.mockClear();
  writelnSpy.mockClear();
  disposeSpy.mockClear();
  FakeWebSocket.instances = [];
  rafCallbacks = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length; // 1-based id
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafCallbacks[id - 1] = undefined;
  });
});

/** Render the panel, wait for the WS to open, deliver `connected`. */
async function mountConnected() {
  const utils = render(
    <MemoryRouter>
      <TerminalPanel isOpen mode="embedded" onClose={vi.fn()} />
    </MemoryRouter>,
  );
  await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
  const ws = FakeWebSocket.instances[0];
  act(() => {
    ws.onmessage?.({
      data: JSON.stringify({ type: 'connected', sessionId: 's1' }),
    });
  });
  // `connected` writes a synchronous clear sequence — drop it from the count.
  writeSpy.mockClear();
  return { ...utils, ws };
}

describe('TerminalPanel rAF write-batching', () => {
  it('coalesces multiple WS data messages into one term.write per frame', async () => {
    const { ws } = await mountConnected();

    ws.onmessage?.({ data: 'aaa' });
    ws.onmessage?.({ data: 'bbb' });
    ws.onmessage?.({ data: 'ccc' });

    // Buffered — nothing written until the frame fires.
    expect(writeSpy).not.toHaveBeenCalled();

    flushRaf();

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith('aaabbbccc');
  });

  it('speedup: write count is independent of message count', async () => {
    const { ws } = await mountConnected();

    for (let i = 0; i < 100; i++) ws.onmessage?.({ data: `m${i};` });
    expect(writeSpy).not.toHaveBeenCalled();

    flushRaf();

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const written = writeSpy.mock.calls[0][0] as string;
    expect(written.startsWith('m0;')).toBe(true);
    expect(written.endsWith('m99;')).toBe(true);
  });

  it('starts a fresh frame after each flush', async () => {
    const { ws } = await mountConnected();

    ws.onmessage?.({ data: 'first' });
    flushRaf();
    ws.onmessage?.({ data: 'second' });
    flushRaf();

    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect(writeSpy).toHaveBeenNthCalledWith(1, 'first');
    expect(writeSpy).toHaveBeenNthCalledWith(2, 'second');
  });

  it('flushes buffered output before the exit line so ordering holds', async () => {
    const { ws } = await mountConnected();

    ws.onmessage?.({ data: 'tail output' });
    // Exit arrives before the rAF fires — handler must flush synchronously.
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: 'exit', exitCode: 0 }),
      });
    });

    expect(writeSpy).toHaveBeenCalledWith('tail output');
    expect(writelnSpy).toHaveBeenCalledTimes(1);
    // The buffered write must land before the "[Process exited]" line.
    const writeOrder = writeSpy.mock.invocationCallOrder[0];
    const writelnOrder = writelnSpy.mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(writelnOrder);

    // A late frame must not double-write the already-flushed bytes.
    writeSpy.mockClear();
    flushRaf();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('cancels a pending frame on unmount — no stale write into a disposed term', async () => {
    const { ws, unmount } = await mountConnected();

    ws.onmessage?.({ data: 'stale bytes' });
    unmount();
    flushRaf();

    expect(writeSpy).not.toHaveBeenCalled();
  });
});

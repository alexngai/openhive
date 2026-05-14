/**
 * Integration tests for `CodexAppServerManager` — exercises the JSON-RPC
 * branching in `handleMessage` against a fake codex app-server (see
 * `fixtures/fake-codex-app-server.js`). No live codex required.
 *
 * Specifically asserts the path added to handle codex's server-initiated
 * approval requests:
 *   - Incoming request (id + method) → emits `request` event, replyToRequest()
 *     writes the JSON-RPC response back over the WS in the right shape
 *   - Plain notification (method only) → still emits `notification` (no regression)
 *   - Response to our outgoing request (id + result/error, no method) →
 *     still resolves the pending promise (no regression)
 *   - Session exit clears in-flight requests + incoming-request ids
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import * as readline from 'node:readline';
import { createServer } from 'node:net';
import { CodexAppServerManager } from '../../swarm/codex-app-server-manager.js';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'fake-codex-app-server.js');

beforeAll(() => {
  // Make sure the fixture is executable — git may not preserve the bit.
  fs.chmodSync(FIXTURE_PATH, 0o755);
});

/**
 * The codex manager spawns its child with `stdio: ['ignore', 'pipe', 'pipe']`,
 * so we drive the fake via a TCP control socket the fixture opens on the
 * port we pass via env. `Harness` owns the control connection + an
 * event-await helper.
 */
interface Harness {
  send: (cmd: Record<string, unknown>) => void;
  next: (predicate: (ev: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
  close: () => void;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function connectHarness(port: number): Promise<Harness> {
  const seen: Record<string, unknown>[] = [];
  const waiters: { predicate: (ev: Record<string, unknown>) => boolean; resolve: (ev: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }[] = [];

  // Retry connect — the fixture's TCP server may need a moment to bind.
  let sock: net.Socket | null = null;
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      sock = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection({ port, host: '127.0.0.1' });
        s.once('error', reject);
        s.once('connect', () => { s.removeListener('error', reject); resolve(s); });
      });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (!sock) throw new Error(`harness: could not connect to fake codex control port ${port}`);

  const rl = readline.createInterface({ input: sock });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line); } catch { return; }
    seen.push(ev);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(ev)) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve(ev);
        waiters.splice(i, 1);
      }
    }
  });

  return {
    send(cmd) {
      sock!.write(JSON.stringify(cmd) + '\n');
    },
    next(predicate, timeoutMs = 5_000) {
      const existing = seen.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`harness event not seen within ${timeoutMs}ms; recent: ${JSON.stringify(seen.slice(-5))}`));
        }, timeoutMs);
        waiters.push({ predicate, resolve, timer });
      });
    },
    close() {
      rl.close();
      sock!.destroy();
    },
  };
}

describe('CodexAppServerManager — incoming-request branch (no live codex)', () => {
  let mgr: CodexAppServerManager;
  let sessionId: string;
  let harness: Harness;

  beforeAll(async () => {
    const controlPort = await freePort();
    mgr = new CodexAppServerManager();
    const info = await mgr.create({
      command: FIXTURE_PATH,
      cwd: process.cwd(),
      env: {
        ...(process.env as Record<string, string>),
        FAKE_CODEX_CONTROL_PORT: String(controlPort),
      },
    });
    sessionId = info.id;
    harness = await connectHarness(controlPort);
  }, 15_000);

  afterAll(() => {
    harness?.close();
    mgr?.destroyAll();
  });

  it('sets up a running session against the fake codex (handshake passes)', () => {
    const info = mgr.getInfo(sessionId);
    expect(info).toBeTruthy();
    expect(info!.status).toBe('running');
    expect(info!.threadId).toMatch(/^fake-thread-/);
    expect(info!.listenUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
  });

  it('emits `request` event when codex sends an incoming JSON-RPC request', async () => {
    const got = new Promise<{ sessionId: string; requestId: string; method: string; params?: unknown }>((resolve) => {
      mgr.once('request', resolve);
    });
    harness.send({
      action: 'send-request',
      id: 'codex-req-1',
      method: 'execCommandApproval',
      params: { command: ['rm', '-rf', '/tmp/foo'], cwd: '/work', reason: 'cleanup' },
    });
    const ev = await Promise.race([
      got,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no request event in 3s')), 3_000)),
    ]);
    expect(ev.sessionId).toBe(sessionId);
    expect(ev.requestId).toBe('codex-req-1');
    expect(ev.method).toBe('execCommandApproval');
    expect((ev.params as { command?: string[] }).command).toEqual(['rm', '-rf', '/tmp/foo']);
  });

  it('replyToRequest writes a JSON-RPC response back over the WS', async () => {
    // Codex sends a request, we reply, fake codex echoes the reply we sent.
    const replyEvent = harness.next((ev) => ev.event === 'reply-received' && ev.id === 'codex-req-2');
    harness.send({
      action: 'send-request',
      id: 'codex-req-2',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 't', turnId: 'tu', itemId: 'i', startedAtMs: Date.now(), command: 'ls', cwd: '/' },
    });
    // Wait for the manager to emit the request, then reply approved.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no manager `request` event')), 3_000);
      mgr.once('request', () => { clearTimeout(timer); resolve(); });
    });
    mgr.replyToRequest(sessionId, 'codex-req-2', { decision: 'approved' });
    const echoed = await replyEvent;
    expect(echoed.result).toEqual({ decision: 'approved' });
    expect(echoed.error).toBeNull();
  });

  it('errorToRequest writes a JSON-RPC error response', async () => {
    const replyEvent = harness.next((ev) => ev.event === 'reply-received' && ev.id === 'codex-req-3');
    harness.send({
      action: 'send-request',
      id: 'codex-req-3',
      method: 'attestation/generate',
      params: {},
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no manager `request` event')), 3_000);
      mgr.once('request', () => { clearTimeout(timer); resolve(); });
    });
    mgr.errorToRequest(sessionId, 'codex-req-3', -32601, 'unsupported method');
    const echoed = await replyEvent;
    expect(echoed.error).toEqual({ code: -32601, message: 'unsupported method' });
    expect(echoed.result).toBeNull();
  });

  it('replyToRequest is a no-op for an unknown requestId (idempotent)', () => {
    // Should not throw, should not write anything.
    expect(() => mgr.replyToRequest(sessionId, 'no-such-request', { decision: 'approved' })).not.toThrow();
    expect(() => mgr.errorToRequest(sessionId, 'no-such-request', -1, 'x')).not.toThrow();
  });

  it('still routes notifications to the `notification` event (no regression)', async () => {
    const got = new Promise<{ sessionId: string; method: string; params?: unknown }>((resolve) => {
      mgr.once('notification', resolve);
    });
    harness.send({
      action: 'send-notification',
      method: 'turn/started',
      params: { turn: { id: 'turn-x' } },
    });
    const ev = await Promise.race([
      got,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no notification in 3s')), 3_000)),
    ]);
    expect(ev.sessionId).toBe(sessionId);
    expect(ev.method).toBe('turn/started');
  });

  it('outgoing-request response still resolves the pending promise (no regression)', async () => {
    // `sendTurn` round-trips through the fake's auto-reply for `turn/start`.
    const ack = await mgr.sendTurn(sessionId, 'hello fake codex');
    expect(ack.turn.id).toMatch(/^fake-turn-/);
  });
});

describe('CodexAppServerManager — session lifecycle cleanup', () => {
  it('purges incoming-request ids when the session exits', async () => {
    const controlPort = await freePort();
    const mgr = new CodexAppServerManager();
    const info = await mgr.create({
      command: FIXTURE_PATH,
      cwd: process.cwd(),
      env: {
        ...(process.env as Record<string, string>),
        FAKE_CODEX_CONTROL_PORT: String(controlPort),
      },
    });
    const session = (mgr as unknown as {
      sessions: Map<string, { incomingRequests: Map<string, string | number> }>;
    }).sessions.get(info.id);
    if (!session) throw new Error('test setup');

    // Inject a fake pending incoming request, then destroy the session.
    session.incomingRequests.set('zombie-1', 'zombie-1');
    expect(session.incomingRequests.has('zombie-1')).toBe(true);

    mgr.destroy(info.id);
    // After destroy() the session is removed from the map entirely.
    const removed = (mgr as unknown as { sessions: Map<string, unknown> }).sessions.get(info.id);
    expect(removed).toBeUndefined();
    // replyToRequest against the gone session is a no-op (would otherwise throw).
    expect(() => mgr.replyToRequest(info.id, 'zombie-1', {})).not.toThrow();
    mgr.destroyAll();
  }, 15_000);
});

#!/usr/bin/env node
/**
 * Fake codex app-server for testing the openhive codex-rpc surface.
 *
 * Mimics the real `codex app-server` startup contract:
 *   - Listens on a random ws://127.0.0.1 port
 *   - Prints "listening on: ws://127.0.0.1:NNNN" to stderr (the URL line
 *     `CodexAppServerManager` scans for)
 *   - Accepts a single WS client connection
 *   - Responds to JSON-RPC requests: `initialize`, `thread/start`,
 *     `turn/start`, `turn/interrupt`, `initialized` (notification)
 *   - Reads scripting commands from stdin (one JSON object per line):
 *       { "action": "send-request", "id": "...", "method": "...", "params": {...} }
 *       { "action": "send-notification", "method": "...", "params": {...} }
 *       { "action": "echo-reply", "id": "..." }    // write the matching reply to stdout when it arrives
 *       { "action": "exit" }
 *
 * Replies received from the openhive client for our server-initiated
 * requests are written to stdout as JSON lines for the test harness to
 * assert against.
 */

import { WebSocketServer } from 'ws';
import { createServer as createNetServer } from 'node:net';

let listenUrlArg = 0;
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--listen' && process.argv[i + 1]) {
    try {
      const u = new URL(process.argv[i + 1]);
      listenUrlArg = parseInt(u.port, 10) || 0;
    } catch { /* leave 0 — auto-assign */ }
  }
}

const wss = new WebSocketServer({ port: listenUrlArg, host: '127.0.0.1' });

wss.on('listening', () => {
  const addr = wss.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  process.stderr.write(`listening on: ws://127.0.0.1:${port}\n`);
});

/** @type {import('ws').WebSocket | null} */
let client = null;

/** Track ids the harness asked us to echo back when a reply arrives. */
const echoRequestIds = new Set();

function emit(line) {
  process.stdout.write(line + '\n');
}

wss.on('connection', (ws) => {
  client = ws;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    // Response to a server-initiated request — surface to harness.
    if (msg.id !== undefined && msg.method === undefined) {
      if (echoRequestIds.has(String(msg.id))) {
        echoRequestIds.delete(String(msg.id));
        emit(JSON.stringify({ event: 'reply-received', id: msg.id, result: msg.result ?? null, error: msg.error ?? null }));
      }
      return;
    }
    // Client request — auto-reply for the boilerplate handshake methods.
    if (msg.id !== undefined && msg.method) {
      switch (msg.method) {
        case 'initialize':
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
          return;
        case 'thread/start':
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { thread: { id: `fake-thread-${Date.now()}` } },
          }));
          return;
        case 'turn/start':
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { turn: { id: `fake-turn-${Date.now()}` } },
          }));
          return;
        case 'turn/interrupt':
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
          return;
        default:
          // Surface unexpected client requests to the harness.
          emit(JSON.stringify({ event: 'client-request', id: msg.id, method: msg.method, params: msg.params ?? null }));
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unsupported in fake: ${msg.method}` } }));
          return;
      }
    }
    // Client notification — surface to harness (e.g. `initialized`, `thread/close`).
    if (msg.method && msg.id === undefined) {
      emit(JSON.stringify({ event: 'client-notification', method: msg.method, params: msg.params ?? null }));
    }
  });
  ws.on('close', () => {
    if (client === ws) client = null;
  });
});

// The codex manager spawns us with `stdio: ['ignore', 'pipe', 'pipe']` —
// stdin isn't writable. Open a TCP control socket on the port the harness
// passed via `FAKE_CODEX_CONTROL_PORT` so it can script our behavior. Each
// connected harness receives all `emit()` events.
/** @type {Set<import('node:net').Socket>} */
const harnessSockets = new Set();

const originalEmit = emit;
const broadcast = (line) => {
  originalEmit(line);
  for (const sock of harnessSockets) {
    try { sock.write(line + '\n'); } catch { /* ignore */ }
  }
};

// Replace emit so server events fan out to harness sockets too. (Local
// rebinding via closure on the references above.)
// eslint-disable-next-line no-func-assign
emit = broadcast;

const controlPort = parseInt(process.env.FAKE_CODEX_CONTROL_PORT ?? '0', 10);
if (controlPort > 0) {
  const ctrl = createNetServer((sock) => {
    harnessSockets.add(sock);
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let cmd;
        try { cmd = JSON.parse(line); } catch { continue; }
        if (cmd.action === 'send-request' && client) {
          const id = cmd.id ?? `fake-req-${Date.now()}`;
          echoRequestIds.add(String(id));
          client.send(JSON.stringify({ jsonrpc: '2.0', id, method: cmd.method, params: cmd.params }));
        } else if (cmd.action === 'send-notification' && client) {
          client.send(JSON.stringify({ jsonrpc: '2.0', method: cmd.method, params: cmd.params }));
        } else if (cmd.action === 'echo-reply' && cmd.id !== undefined) {
          echoRequestIds.add(String(cmd.id));
        } else if (cmd.action === 'exit') {
          process.exit(0);
        }
      }
    });
    sock.on('close', () => { harnessSockets.delete(sock); });
    sock.on('error', () => { harnessSockets.delete(sock); });
  });
  ctrl.listen(controlPort, '127.0.0.1');
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

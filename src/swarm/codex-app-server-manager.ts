/**
 * Codex app-server pool — manages `codex app-server` child processes and
 * their JSON-RPC WebSocket clients on behalf of `kind: 'codex'` swarms in
 * `mode: 'rpc'`. Analog to PtyManager but the underlying process is a
 * long-running JSON-RPC server, not a TTY-bound TUI.
 *
 * Lifecycle per session:
 *   1. spawn `codex app-server --listen ws://127.0.0.1:0`
 *   2. parse stderr for `listening on: ws://127.0.0.1:NNNN`
 *   3. open a WebSocket to that URL
 *   4. send `initialize` request, then `initialized` notification
 *   5. send `thread/start` and capture the thread id
 *   6. expose `sendTurn(sessionId, text)` for openhive's chat layer to drive
 *   7. emit per-session `notification` events so consumers can fan out
 *      streaming updates (`item/agentMessage/delta`, `turn/completed`, etc.)
 *
 * On stop: send `thread/close` (best-effort), close the WS, send SIGTERM
 * to the child. On crash: emit a `session.exit` event so the manager
 * can flip the row state.
 *
 * Listen URL is on stderr (gotcha — confirmed by probe). Process child
 * stdio is fully captured; nothing leaks to openhive's stdout/stderr.
 */

import { EventEmitter } from 'node:events';
import { spawn as procSpawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { nanoid } from 'nanoid';

// =============================================================================
// Types
// =============================================================================

export interface CodexAppServerSpawnConfig {
  /** Path to the `codex` binary (resolved by caller). */
  command: string;
  /** Working directory passed to the child + used as cwd for thread/start. */
  cwd: string;
  /** Env override; defaults to inherited process.env. */
  env?: Record<string, string>;
  /** Optional first-turn prompt; if set, fires `turn/start` after init. */
  initialPrompt?: string;
}

export type CodexAppServerSessionStatus = 'starting' | 'running' | 'stopped' | 'failed';

export interface CodexAppServerSessionInfo {
  id: string;
  pid: number;
  cwd: string;
  status: CodexAppServerSessionStatus;
  /** Local WS URL the child is listening on. */
  listenUrl: string | null;
  /** Codex thread id from `thread/start` response. */
  threadId: string | null;
  createdAt: number;
  stoppedAt: number | null;
  exitCode: number | null;
}

interface InternalSession {
  id: string;
  child: ChildProcess;
  ws: WebSocket | null;
  config: CodexAppServerSpawnConfig;
  status: CodexAppServerSessionStatus;
  listenUrl: string | null;
  threadId: string | null;
  createdAt: number;
  stoppedAt: number | null;
  exitCode: number | null;
  /** Pending JSON-RPC request resolvers, keyed by id. */
  pendingRequests: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  nextRequestId: number;
  /**
   * Incoming JSON-RPC requests codex sent that we haven't replied to yet.
   * Keyed by the stringified id (the form we expose externally); value is
   * the wire-original id (string | number). Codex's `RequestId` is a
   * `string | number` union — if codex sends `id: 0` and we reply with
   * `id: "0"`, codex won't match the response, so we must preserve the
   * exact wire type.
   */
  incomingRequests: Map<string, string | number>;
}

const MAX_SESSIONS = 20;
const LISTEN_URL_REGEX = /listening on: (ws:\/\/[^\s]+)/;
const REQUEST_TIMEOUT_MS = 60_000;

// =============================================================================
// Manager
// =============================================================================

export class CodexAppServerManager extends EventEmitter {
  private sessions = new Map<string, InternalSession>();

  /**
   * Spawn a fresh `codex app-server`, drive it through `initialize` →
   * `thread/start`, and (if an initial prompt is set) `turn/start`. Returns
   * once the thread id is captured (or rejects on failure).
   */
  async create(config: CodexAppServerSpawnConfig): Promise<CodexAppServerSessionInfo> {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Maximum number of codex app-server sessions (${MAX_SESSIONS}) reached`);
    }

    const id = nanoid();
    const env = { ...(config.env ?? (process.env as Record<string, string>)) };

    const child = procSpawn(
      config.command,
      ['app-server', '--listen', 'ws://127.0.0.1:0'],
      {
        cwd: config.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const session: InternalSession = {
      id,
      child,
      ws: null,
      config,
      status: 'starting',
      listenUrl: null,
      threadId: null,
      createdAt: Date.now(),
      stoppedAt: null,
      exitCode: null,
      pendingRequests: new Map(),
      nextRequestId: 1,
      incomingRequests: new Map(),
    };
    this.sessions.set(id, session);

    // Capture stderr (where the listen URL lives) and stdout. Both go into
    // the URL scanner — codex prints to stderr today, but we accept either
    // in case of upstream shifts.
    const scan = (chunk: Buffer): void => {
      if (session.listenUrl) return;
      const text = chunk.toString();
      const match = LISTEN_URL_REGEX.exec(text);
      if (match) session.listenUrl = match[1];
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);

    child.once('exit', (code, signal) => {
      session.status = session.status === 'starting' ? 'failed' : 'stopped';
      session.stoppedAt = Date.now();
      session.exitCode = code;
      this.emit('session.exit', { sessionId: id, exitCode: code, signal });
      // Reject any in-flight requests so callers don't hang
      for (const [, p] of session.pendingRequests) {
        clearTimeout(p.timer);
        p.reject(new Error(`codex app-server exited (code=${code ?? 'null'} signal=${signal ?? 'none'})`));
      }
      session.pendingRequests.clear();
      // Drop any incoming-request ids — codex is gone, replies would race.
      session.incomingRequests.clear();
    });

    // Wait for the listen URL to appear (~5s should be plenty; the probe
    // saw it inside 1s).
    const deadline = Date.now() + 10_000;
    while (!session.listenUrl && Date.now() < deadline) {
      if (session.exitCode !== null) {
        throw new Error(`codex app-server exited before printing listen URL (code=${session.exitCode})`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!session.listenUrl) {
      this.destroy(id);
      throw new Error('codex app-server did not print a listen URL within 10s');
    }

    // Connect WS, drive the protocol handshake.
    const ws = new WebSocket(session.listenUrl);
    session.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error): void => reject(err);
      ws.once('error', onErr);
      ws.once('open', () => { ws.removeListener('error', onErr); resolve(); });
    });

    ws.on('message', (raw) => this.handleMessage(session, raw));
    ws.on('error', (err) => {
      this.emit('session.error', { sessionId: id, error: err });
    });
    ws.on('close', () => {
      // If the WS dropped but the child is still alive, the session is in a
      // bad state — let the destroy path tidy up.
      if (session.status === 'running' || session.status === 'starting') {
        session.status = 'failed';
        session.stoppedAt = Date.now();
        this.emit('session.ws_close', { sessionId: id });
      }
    });

    // initialize → initialized notification → thread/start
    await this.request(session, 'initialize', {
      clientInfo: { name: 'openhive', version: '0.1.0', title: 'openhive' },
      capabilities: {},
    });
    this.notify(session, 'initialized', undefined);

    const startResult = await this.request<{ thread: { id: string } }>(
      session,
      'thread/start',
      { cwd: config.cwd },
    );
    session.threadId = startResult.thread.id;
    session.status = 'running';

    // Optional first-turn prompt — fire and forget; deltas stream via
    // notifications.
    if (config.initialPrompt && config.initialPrompt.trim().length > 0) {
      this.sendTurn(id, config.initialPrompt).catch((err) => {
        this.emit('session.error', { sessionId: id, error: err });
      });
    }

    this.emit('session.created', { sessionId: id, pid: child.pid, threadId: session.threadId });
    console.log(
      `[codex-rpc] Session ${id} ready: pid=${child.pid} listen=${session.listenUrl} thread=${session.threadId}`,
    );

    return this.getInfo(id)!;
  }

  /** Submit a new user turn against the session's thread. Returns the
   *  `turn/start` ack (the turn id is in the response). Streaming text and
   *  completion arrive as notifications via the `notification` event. */
  async sendTurn(sessionId: string, text: string): Promise<{ turn: { id: string } }> {
    const session = this.requireSession(sessionId);
    if (!session.threadId) throw new Error('session has no thread id (call create() first)');
    return this.request<{ turn: { id: string } }>(session, 'turn/start', {
      threadId: session.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    });
  }

  /** Interrupt the current turn (clean cancel via codex protocol). */
  async interrupt(sessionId: string, turnId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.request(session, 'turn/interrupt', { turnId });
  }

  /**
   * Tear down a session: send `thread/close` (best-effort), close the WS,
   * send SIGTERM to the child. Falls back to SIGKILL after a short grace if
   * the child doesn't exit. Idempotent.
   */
  destroy(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Best-effort thread close — ignore failures, the child is going down anyway.
    if (session.ws && session.ws.readyState === WebSocket.OPEN && session.threadId) {
      try {
        this.notify(session, 'thread/close', { threadId: session.threadId });
      } catch { /* ignore */ }
    }

    try { session.ws?.close(); } catch { /* ignore */ }

    if (!session.child.killed && session.child.exitCode === null) {
      try { session.child.kill('SIGTERM'); } catch { /* already gone */ }
      // Force-kill after 2s if SIGTERM doesn't take.
      setTimeout(() => {
        if (!session.child.killed && session.child.exitCode === null) {
          try { session.child.kill('SIGKILL'); } catch { /* gone */ }
        }
      }, 2_000).unref();
    }

    if (session.status !== 'stopped' && session.status !== 'failed') {
      session.status = 'stopped';
      session.stoppedAt = Date.now();
    }
    this.sessions.delete(sessionId);
    this.emit('session.destroyed', { sessionId });
  }

  destroyAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      try { this.destroy(id); } catch { /* ignore */ }
    }
  }

  getInfo(sessionId: string): CodexAppServerSessionInfo | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      id: session.id,
      pid: session.child.pid ?? 0,
      cwd: session.config.cwd,
      status: session.status,
      listenUrl: session.listenUrl,
      threadId: session.threadId,
      createdAt: session.createdAt,
      stoppedAt: session.stoppedAt,
      exitCode: session.exitCode,
    };
  }

  list(): CodexAppServerSessionInfo[] {
    return Array.from(this.sessions.keys())
      .map((id) => this.getInfo(id))
      .filter((info): info is CodexAppServerSessionInfo => info !== null);
  }

  // =============================================================================
  // Internal: JSON-RPC plumbing
  // =============================================================================

  private requireSession(id: string): InternalSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`codex session ${id} not found`);
    if (s.status !== 'running' && s.status !== 'starting') {
      throw new Error(`codex session ${id} is in state '${s.status}'`);
    }
    if (!s.ws || s.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`codex session ${id} ws is not open`);
    }
    return s;
  }

  private request<T = unknown>(
    session: InternalSession,
    method: string,
    params: unknown,
  ): Promise<T> {
    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('ws not open'));
    }
    const id = `r${session.nextRequestId++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (session.pendingRequests.has(id)) {
          session.pendingRequests.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, REQUEST_TIMEOUT_MS);
      session.pendingRequests.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      session.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  private notify(session: InternalSession, method: string, params: unknown): void {
    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) return;
    const payload: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (params !== undefined) payload.params = params;
    session.ws.send(JSON.stringify(payload));
  }

  private handleMessage(session: InternalSession, raw: WebSocket.RawData): void {
    let msg: { id?: string | number; result?: unknown; error?: { code: number; message: string }; method?: string; params?: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Three cases:
    //  - id + (result|error), no method  → response to a request we sent
    //  - id + method                     → incoming request from codex (needs a reply)
    //  - method only                     → notification (fire-and-forget)
    if (msg.id !== undefined && msg.method === undefined) {
      const handler = session.pendingRequests.get(String(msg.id));
      if (!handler) return;
      session.pendingRequests.delete(String(msg.id));
      clearTimeout(handler.timer);
      if (msg.error) handler.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else handler.resolve(msg.result);
      return;
    }

    if (msg.id !== undefined && msg.method) {
      // Incoming request from codex — preserve the wire-original id (which
      // may be a number per `RequestId` in codex's schema) so the eventual
      // response matches codex's pending-request table.
      const wireId = msg.id;
      const requestId = String(wireId);
      session.incomingRequests.set(requestId, wireId);
      this.emit('request', {
        sessionId: session.id,
        requestId,
        method: msg.method,
        params: msg.params,
      });
      return;
    }

    if (msg.method) {
      this.emit('notification', {
        sessionId: session.id,
        method: msg.method,
        params: msg.params,
      });
    }
  }

  /**
   * Send a successful JSON-RPC response back to codex for an incoming
   * request. `requestId` is the id codex emitted (preserved verbatim).
   * No-op if the session is gone or the request was already replied to.
   */
  replyToRequest(sessionId: string, requestId: string, result: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const wireId = session.incomingRequests.get(requestId);
    if (wireId === undefined) return;
    session.incomingRequests.delete(requestId);
    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) return;
    session.ws.send(JSON.stringify({ jsonrpc: '2.0', id: wireId, result }));
  }

  /**
   * Send an error JSON-RPC response back to codex for an incoming request.
   * Use when the host can't fulfil the request (e.g. unsupported method or
   * an exception while computing the reply). No-op if the session is gone
   * or the request was already replied to.
   */
  errorToRequest(
    sessionId: string,
    requestId: string,
    code: number,
    message: string,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const wireId = session.incomingRequests.get(requestId);
    if (wireId === undefined) return;
    session.incomingRequests.delete(requestId);
    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) return;
    session.ws.send(JSON.stringify({ jsonrpc: '2.0', id: wireId, error: { code, message } }));
  }
}

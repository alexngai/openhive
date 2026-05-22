/**
 * TerminalPanel
 *
 * Embeds a ghostty-web terminal that connects to a backend PTY session
 * via WebSocket. Used to tunnel the OpenSwarm TUI through the browser.
 *
 * When a `swarm` target is provided, the component fetches the TUI binary
 * info from the server and spawns a PTY running the OpenSwarm TUI
 * auto-connected to the swarm's MAP endpoint.
 *
 * Adapted from references/swarmcraft/src/ui/components/terminal/TerminalPanel.tsx
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { init, Terminal, FitAddon } from 'ghostty-web';
import { api } from '../../lib/api';
import { generateQueryResponses } from './query-responses';
import { setupMouseBridge } from './terminal-mouse';

// =============================================================================
// Types
// =============================================================================

export interface TerminalSessionInfo {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  status: 'running' | 'stopped' | 'failed';
  pid: number;
  createdAt: number;
  stoppedAt: number | null;
  exitCode: number | null;
}

/** Target swarm for the terminal session */
export interface SwarmTarget {
  /** Hosted swarm ID */
  swarmId: string;
  /** Display name */
  swarmName?: string;
  /**
   * MAP endpoint (e.g., ws://127.0.0.1:3100). Optional — TUI kinds
   * (claude-code, codex) attach by sessionId and don't have a meaningful
   * endpoint to display, so callers pass undefined / empty string.
   */
  endpoint?: string;
}

/** What kind of session to launch against the swarm. */
export type TerminalSessionMode = 'tui' | 'shell';

interface TerminalPanelProps {
  /** If provided, attach to an existing session instead of creating one */
  sessionId?: string;
  /** Swarm to connect the TUI to */
  swarm?: SwarmTarget;
  /** Whether the panel is visible */
  isOpen: boolean;
  /** Close callback */
  onClose: () => void;
  /** Called when a session is created or attached */
  onSessionReady?: (session: TerminalSessionInfo) => void;
  /** Render mode: 'overlay' (floating modal) or 'embedded' (fills parent) */
  mode?: 'overlay' | 'embedded';
  /** Session kind: 'tui' (OpenSwarm TUI, default) or 'shell' ($SHELL in cwd). */
  sessionMode?: TerminalSessionMode;
  /**
   * In 'embedded' mode, suppress the header's "← Back to Swarms" link. Set
   * when the panel is hosted inside another page (e.g. the Threads detail
   * Terminal tab) where that navigation target makes no sense.
   */
  hideEmbeddedBackLink?: boolean;
}

// =============================================================================
// WASM Initialization
// =============================================================================

let wasmReady = false;
let wasmInitPromise: Promise<void> | null = null;

function ensureWasmInit(): Promise<void> {
  if (wasmReady) return Promise.resolve();
  if (!wasmInitPromise) {
    wasmInitPromise = init().then(() => {
      wasmReady = true;
    });
  }
  return wasmInitPromise;
}

// =============================================================================
// Component
// =============================================================================

export function TerminalPanel({
  sessionId: existingSessionId,
  swarm,
  isOpen,
  onClose,
  onSessionReady,
  mode = 'overlay',
  sessionMode = 'tui',
  hideEmbeddedBackLink = false,
}: TerminalPanelProps) {
  // Derive WS base URL from current location
  const wsBase = useMemo(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}`;
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mouseCleanupRef = useRef<(() => void) | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  // Pending PTY output, flushed to ghostty-web once per animation frame.
  // The server sends many small frames per TUI redraw; writing each one
  // synchronously thrashes the WASM renderer. Batching to ~60fps coalesces
  // them into one write per paint without adding perceptible latency.
  const writeBufRef = useRef<string>('');
  const writeRafRef = useRef<number | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('disconnected');
  const [sessionInfo, setSessionInfo] = useState<TerminalSessionInfo | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Stable refs for props that change identity each render (object literals)
  const swarmRef = useRef(swarm);
  swarmRef.current = swarm;
  const existingSessionIdRef = useRef(existingSessionId);
  existingSessionIdRef.current = existingSessionId;
  const sessionModeRef = useRef(sessionMode);
  sessionModeRef.current = sessionMode;

  // Connection version counter: incremented on every connect/cleanup so stale
  // async connect() calls (e.g. from React Strict Mode double-fire) bail out.
  const connectVersionRef = useRef(0);

  const cleanup = useCallback(() => {
    connectVersionRef.current++;
    console.debug('[terminal] cleanup (v=%d): closing ws and disposing terminal', connectVersionRef.current);
    mouseCleanupRef.current?.();
    mouseCleanupRef.current = null;
    if (writeRafRef.current !== null) {
      cancelAnimationFrame(writeRafRef.current);
      writeRafRef.current = null;
    }
    writeBufRef.current = '';
    wsRef.current?.close();
    wsRef.current = null;
    terminalRef.current?.dispose();
    terminalRef.current = null;
    fitAddonRef.current = null;
  }, []);

  const connect = useCallback(async (reuseSession = false) => {
    // Bump version — any in-flight connect() with older version will bail out
    const version = ++connectVersionRef.current;
    const stale = () => {
      if (connectVersionRef.current !== version) {
        console.debug('[terminal] connect v=%d superseded by v=%d, aborting', version, connectVersionRef.current);
        return true;
      }
      return false;
    };

    console.debug('[terminal] connect() v=%d called, reuseSession=%s, containerRef=%o', version, reuseSession, !!containerRef.current);
    if (!containerRef.current) return;

    // Read from stable refs
    const currentSwarm = swarmRef.current;
    const currentExistingSessionId = existingSessionIdRef.current;
    const currentSessionMode = sessionModeRef.current;

    // Close previous WebSocket but keep session ID for reconnect
    const previousSessionId = activeSessionIdRef.current;
    if (wsRef.current) {
      console.debug('[terminal] closing previous WebSocket');
      wsRef.current.close();
      wsRef.current = null;
    }
    // Drop any pending output from the previous connection — a queued rAF
    // must not write stale bytes into the fresh terminal created below.
    if (writeRafRef.current !== null) {
      cancelAnimationFrame(writeRafRef.current);
      writeRafRef.current = null;
    }
    writeBufRef.current = '';

    setStatus('connecting');
    setErrorMsg(null);

    try {
      console.debug('[terminal] initializing WASM...');
      await ensureWasmInit();
      if (stale()) return;
      console.debug('[terminal] WASM ready');
    } catch (err) {
      if (stale()) return;
      console.error('[terminal] WASM init failed:', err);
      setStatus('error');
      setErrorMsg(`Failed to initialize terminal WASM: ${(err as Error).message}`);
      return;
    }

    // Clean up previous terminal
    if (terminalRef.current) {
      console.debug('[terminal] disposing previous terminal');
      terminalRef.current.dispose();
      terminalRef.current = null;
    }

    // Create terminal
    console.debug('[terminal] creating new Terminal instance');
    const term = new Terminal({
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: '#0a0a0f',
        foreground: '#e0e0e0',
        cursor: '#ffffff',
        selectionBackground: '#3a3a5c',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Mount terminal to DOM
    term.open(containerRef.current);
    fitAddon.fit();
    console.debug('[terminal] terminal mounted, cols=%d rows=%d', term.cols, term.rows);

    // Build WebSocket URL
    const params = new URLSearchParams();
    params.set('cols', String(term.cols));
    params.set('rows', String(term.rows));

    // Reconnect reuses the previous session; otherwise use the prop or create new
    const attachSessionId = reuseSession ? previousSessionId : currentExistingSessionId;
    if (attachSessionId) {
      console.debug('[terminal] attaching to existing session: %s', attachSessionId);
      params.set('sessionId', attachSessionId);
    } else if (currentSwarm) {
      // Fetch session config from the server. The server resolves the binary
      // / shell path and any sandbox/cwd config; the client just forwards.
      console.debug(
        '[terminal] fetching terminal-info for swarm: %s (mode=%s)',
        currentSwarm.swarmId,
        currentSessionMode,
      );
      try {
        const info = await api.get<{
          mode: 'tui' | 'shell';
          /**
           * 'attach' means the server already has a running PTY session
           * for this swarm (e.g. kind=claude-code) and we should attach
           * by sessionId. Default (absent or 'spawn') means we ask the
           * WS to spawn a fresh PTY with the returned command/args.
           */
          binding?: 'attach' | 'spawn';
          available: boolean;
          command: string | null;
          args: string[];
          cwd?: string;
          sandbox?: boolean;
          sessionId?: string | null;
          endpoint: string | null;
        }>(`/map/hosted/${currentSwarm.swarmId}/terminal-info?mode=${currentSessionMode}`);

        if (stale()) { term.dispose(); return; }

        console.debug('[terminal] terminal-info response:', info);

        // Attach mode: server already owns the PTY, we just attach by id.
        if (info.binding === 'attach') {
          if (!info.available || !info.sessionId) {
            setStatus('error');
            setErrorMsg(
              'No running terminal session for this swarm. The TUI may have exited.',
            );
            return;
          }
          params.set('sessionId', info.sessionId);
        } else {
          if (!info.available || !info.command) {
            setStatus('error');
            setErrorMsg(
              currentSessionMode === 'shell'
                ? 'Shell mode unavailable for this swarm'
                : 'OpenSwarm TUI binary not available on this server',
            );
            return;
          }
          params.set('command', info.command);
          params.set('args', JSON.stringify(info.args));
          if (info.cwd) params.set('cwd', info.cwd);
          if (info.sandbox) params.set('sandbox', '1');
        }
      } catch (err) {
        if (stale()) { term.dispose(); return; }
        console.error('[terminal] terminal-info fetch failed:', err);
        setStatus('error');
        setErrorMsg(`Failed to resolve session: ${(err as Error).message}`);
        return;
      }
    } else {
      console.debug('[terminal] no swarm and no sessionId — spawning default shell');
    }

    // Final stale check before opening WebSocket (the expensive/side-effectful part)
    if (stale()) {
      term.dispose();
      return;
    }

    const wsUrl = `${wsBase}/ws/terminal?${params}`;
    console.debug('[terminal] connecting WebSocket: %s', wsUrl);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.debug('[terminal] WebSocket open (v=%d)', version);
    };

    ws.onmessage = (event) => {
      const activeTerm = terminalRef.current;
      if (!activeTerm) {
        console.warn('[terminal] ws.onmessage: terminal ref is null, ignoring data');
        return;
      }

      const data = event.data;

      // Try parsing as JSON for control messages
      if (typeof data === 'string' && data.startsWith('{')) {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'connected' && msg.sessionId) {
            console.debug('[terminal] connected to session: %s', msg.sessionId);
            activeSessionIdRef.current = msg.sessionId;
            setStatus('connected');
            const wsRef2 = wsRef.current;
            const term2 = terminalRef.current;
            if (term2) {
              // Erase scrollback + visible screen + home cursor before the
              // server's replay buffer arrives. \x1b[3J nukes saved
              // buffer, \x1b[2J clears visible screen, \x1b[H homes the
              // cursor. The server then sends the per-session output
              // ring buffer (PtyManager.getRecentOutput) which renders
              // claude/codex's last alt-screen frame onto the cleared
              // xterm — no SIGWINCH dance needed.
              term2.write('\x1b[3J\x1b[2J\x1b[H');
            }
            // Single resize-to-current. If the PTY is already at this
            // size (common: same-tab reattach without browser resize),
            // node-pty short-circuits — harmless no-op. If the browser
            // was resized between detach and reattach, this triggers a
            // real SIGWINCH and claude/codex redraws at the new size,
            // overwriting the replayed historical frame.
            if (wsRef2 && wsRef2.readyState === WebSocket.OPEN && term2) {
              wsRef2.send(JSON.stringify({ type: 'resize', cols: term2.cols, rows: term2.rows }));
            }
            return;
          }
          if (msg.type === 'exit') {
            console.debug('[terminal] process exited: code=%d signal=%s', msg.exitCode, msg.signal);
            activeSessionIdRef.current = null;
            setStatus('disconnected');
            // Flush any buffered output first so the exit line lands last.
            if (writeRafRef.current !== null) {
              cancelAnimationFrame(writeRafRef.current);
              writeRafRef.current = null;
            }
            if (writeBufRef.current.length > 0) {
              activeTerm.write(writeBufRef.current);
              writeBufRef.current = '';
            }
            activeTerm.writeln(`\r\n\x1b[90m[Process exited with code ${msg.exitCode}]\x1b[0m`);
            return;
          }
          if (msg.type === 'error') {
            console.error('[terminal] server error:', msg.message);
            setStatus('error');
            setErrorMsg(msg.message);
            return;
          }
        } catch {
          // Not JSON control message, treat as terminal data
        }
      }

      // Terminal output — buffer and flush once per animation frame.
      writeBufRef.current += data;
      if (writeRafRef.current === null) {
        writeRafRef.current = requestAnimationFrame(() => {
          writeRafRef.current = null;
          const pending = writeBufRef.current;
          writeBufRef.current = '';
          if (pending.length > 0) {
            terminalRef.current?.write(pending);
          }
        });
      }

      // Inject responses for terminal capability queries that ghostty-web
      // doesn't answer. generateQueryResponses gates internally — cheap for
      // the common (non-query) redraw frame, so no pre-check is needed here.
      if (typeof data === 'string') {
        const fakeResponses = generateQueryResponses(data, activeTerm.cols, activeTerm.rows);
        if (fakeResponses) {
          console.debug('[terminal] injecting %d bytes of query responses', fakeResponses.length);
          const activeWs = wsRef.current;
          if (activeWs && activeWs.readyState === WebSocket.OPEN) {
            activeWs.send(fakeResponses);
          }
        }
      }
    };

    ws.onclose = (event) => {
      console.debug('[terminal] WebSocket closed: code=%d reason=%s', event.code, event.reason);
      setStatus('disconnected');
    };

    ws.onerror = (event) => {
      console.error('[terminal] WebSocket error:', event);
      setStatus('error');
      setErrorMsg('WebSocket connection failed');
      ws.close();
    };

    // User input -> WebSocket (use wsRef to avoid stale closure)
    term.onData((data: string) => {
      const activeWs = wsRef.current;
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(data);
      }
    });

    // Handle resize (use wsRef to avoid stale closure)
    term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      console.debug('[terminal] resize: cols=%d rows=%d', cols, rows);
      const activeWs = wsRef.current;
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    // Mouse events -> WebSocket (SGR mouse protocol bridge)
    mouseCleanupRef.current?.();
    mouseCleanupRef.current = setupMouseBridge(term, (data: string) => {
      const activeWs = wsRef.current;
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(data);
      }
    });

    // Auto-resize on container changes
    fitAddon.observeResize();
  }, [wsBase]); // stable deps only — swarm/sessionId read from refs

  // Connect when panel opens
  useEffect(() => {
    if (isOpen || mode === 'embedded') {
      connect();
    }
    return cleanup;
  }, [isOpen, mode, connect, cleanup]);

  // Focus terminal when panel opens
  useEffect(() => {
    if ((isOpen || mode === 'embedded') && terminalRef.current) {
      terminalRef.current.focus();
    }
  }, [isOpen, mode]);

  if (!isOpen && mode === 'overlay') return null;

  // Header label
  const headerLabel = swarm?.swarmName
    ? `Terminal — ${swarm.swarmName}`
    : swarm?.swarmId
      ? `Terminal — ${swarm.swarmId}`
      : 'Terminal';

  const statusDot = (
    <span
      className={`inline-block w-2 h-2 rounded-full ${
        status === 'connected'
          ? 'bg-emerald-400'
          : status === 'connecting'
            ? 'bg-yellow-400 animate-pulse'
            : status === 'error'
              ? 'bg-red-400'
              : 'bg-white/20'
      }`}
    />
  );

  const headerContent = (
    <div
      className={`flex items-center justify-between px-4 py-2 border-b ${mode === 'overlay' ? 'rounded-t-xl' : ''}`}
      style={{
        backgroundColor: 'var(--color-elevated, rgba(255,255,255,0.05))',
        borderColor: 'var(--color-border-subtle, rgba(255,255,255,0.1))',
      }}
    >
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
          {headerLabel}
        </span>
        {swarm?.endpoint && (
          <span className="text-xs font-mono" style={{ color: 'var(--color-text-muted, rgba(255,255,255,0.4))' }}>
            {swarm.endpoint}
          </span>
        )}
        {statusDot}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => connect(true)}
          className="btn btn-ghost text-xs"
          title="Reconnect to existing session"
        >
          Reconnect
        </button>
        {mode === 'embedded' ? (
          hideEmbeddedBackLink ? null : (
            <Link to="/swarms" className="btn btn-ghost text-xs">
              &larr; Back to Swarms
            </Link>
          )
        ) : (
          <button
            onClick={onClose}
            className="btn btn-ghost text-xs"
            title="Close terminal"
          >
            &times;
          </button>
        )}
      </div>
    </div>
  );

  const errorBanner = errorMsg && (
    <div
      className="px-4 py-2 border-b text-xs"
      style={{
        backgroundColor: 'var(--color-danger-bg)',
        borderColor: 'var(--color-danger-border)',
        color: 'var(--color-danger)',
      }}
    >
      {errorMsg}
    </div>
  );

  // The terminal canvas itself is always dark — the ghostty-web theme is
  // fixed to #0a0a0f regardless of the app theme — so this container stays
  // dark to match. Surrounding chrome (header, error banner) follows the
  // app theme.
  const terminalContainer = (
    <div ref={containerRef} className="flex-1 min-h-0 p-1" style={{ backgroundColor: '#0a0a0f' }} />
  );

  if (mode === 'embedded') {
    return (
      <div
        className="h-full flex flex-col"
        style={{ backgroundColor: 'var(--color-surface)' }}
      >
        {headerContent}
        {errorBanner}
        {terminalContainer}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm">
      <div
        className="w-full max-w-5xl flex flex-col rounded-t-xl shadow-2xl border overflow-hidden"
        style={{
          height: '60vh',
          backgroundColor: 'var(--color-surface)',
          borderColor: 'var(--color-border-subtle, rgba(255,255,255,0.1))',
        }}
      >
        {headerContent}
        {errorBanner}
        {terminalContainer}
      </div>
    </div>
  );
}

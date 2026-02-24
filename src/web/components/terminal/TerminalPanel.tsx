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
  /** MAP endpoint (e.g., ws://127.0.0.1:3100) */
  endpoint: string;
}

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
}

// =============================================================================
// Terminal Query Response Injection
// =============================================================================

// ghostty-web (WASM) only responds to \x1b[6n (DSR cursor position).
// Many TUI frameworks (Bubble Tea, libvaxis, etc.) send capability queries
// (DECRQM, XTVERSION, pixel size, kitty keyboard) and block until they get
// responses. We intercept PTY output and inject the missing responses.

const DECRQM_RE = /\x1b\[\?(\d+)\$p/g;       // \x1b[?N$p → respond \x1b[?N;0$y (not recognized)
const XTVERSION_RE = /\x1b\[>0q/g;            // \x1b[>0q  → respond with version string
const PIXEL_SIZE_RE = /\x1b\[14t/g;           // \x1b[14t  → respond with pixel size
const KITTY_KB_RE = /\x1b\[\?u/g;             // \x1b[?u   → respond with flags=0
const DA1_RE = /\x1b\[c/g;                    // \x1b[c    → DA1 device attributes
const KITTY_GFX_RE = /\x1b_G[^\x1b]*\x1b\\/g; // \x1b_G...ST → Kitty graphics query

/** DECRQM modes we know we support (report as "set") */
const DECRQM_SET_MODES = new Set([2004, 1049, 1004, 2027, 2026, 1000, 1002, 1003, 1006]);

/**
 * Scan PTY output for terminal queries that ghostty-web won't answer,
 * and return fake responses to send back to the PTY.
 */
function generateQueryResponses(data: string, cols: number, rows: number): string {
  let responses = '';

  // DECRQM: \x1b[?N$p → \x1b[?N;{1=set|2=reset|0=unknown}$y
  let m: RegExpExecArray | null;
  DECRQM_RE.lastIndex = 0;
  while ((m = DECRQM_RE.exec(data)) !== null) {
    const mode = parseInt(m[1], 10);
    const status = DECRQM_SET_MODES.has(mode) ? 1 : 0;
    responses += `\x1b[?${mode};${status}$y`;
  }

  // XTVERSION: \x1b[>0q → \x1bP>|ghostty-web 0.4.0\x1b\\
  XTVERSION_RE.lastIndex = 0;
  if (XTVERSION_RE.test(data)) {
    responses += `\x1bP>|ghostty-web 0.4.0\x1b\\`;
  }

  // DA1 (Device Attributes): \x1b[c → \x1b[?62;22c (VT220 with ANSI color)
  DA1_RE.lastIndex = 0;
  if (DA1_RE.test(data)) {
    responses += `\x1b[?62;22c`;
  }

  // Text area pixel size: \x1b[14t → \x1b[4;height;widtht
  // Estimate from cell dimensions (fontSize 14 ≈ 8px wide, 17px tall)
  PIXEL_SIZE_RE.lastIndex = 0;
  if (PIXEL_SIZE_RE.test(data)) {
    const pxW = cols * 8;
    const pxH = rows * 17;
    responses += `\x1b[4;${pxH};${pxW}t`;
  }

  // Kitty keyboard protocol query: \x1b[?u → \x1b[?0u (flags=0, not supported)
  KITTY_KB_RE.lastIndex = 0;
  if (KITTY_KB_RE.test(data)) {
    responses += `\x1b[?0u`;
  }

  // Kitty graphics query: \x1b_G...ST → respond not supported
  KITTY_GFX_RE.lastIndex = 0;
  if (KITTY_GFX_RE.test(data)) {
    responses += `\x1b_Gi=31337;ENOTSUPPORTED\x1b\\`;
  }

  return responses;
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
  const activeSessionIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('disconnected');
  const [sessionInfo, setSessionInfo] = useState<TerminalSessionInfo | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Stable refs for props that change identity each render (object literals)
  const swarmRef = useRef(swarm);
  swarmRef.current = swarm;
  const existingSessionIdRef = useRef(existingSessionId);
  existingSessionIdRef.current = existingSessionId;

  // Connection version counter: incremented on every connect/cleanup so stale
  // async connect() calls (e.g. from React Strict Mode double-fire) bail out.
  const connectVersionRef = useRef(0);

  const cleanup = useCallback(() => {
    connectVersionRef.current++;
    console.debug('[terminal] cleanup (v=%d): closing ws and disposing terminal', connectVersionRef.current);
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

    // Close previous WebSocket but keep session ID for reconnect
    const previousSessionId = activeSessionIdRef.current;
    if (wsRef.current) {
      console.debug('[terminal] closing previous WebSocket');
      wsRef.current.close();
      wsRef.current = null;
    }

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
      // Fetch TUI binary info from the server
      console.debug('[terminal] fetching terminal-info for swarm: %s', currentSwarm.swarmId);
      try {
        const info = await api.get<{
          available: boolean;
          command: string;
          args: string[];
          endpoint: string;
        }>(`/map/hosted/${currentSwarm.swarmId}/terminal-info`);

        if (stale()) { term.dispose(); return; }

        console.debug('[terminal] terminal-info response:', info);

        if (!info.available) {
          setStatus('error');
          setErrorMsg('OpenSwarm TUI binary not available on this server');
          return;
        }

        params.set('command', info.command);
        params.set('args', JSON.stringify(info.args));
      } catch (err) {
        if (stale()) { term.dispose(); return; }
        console.error('[terminal] terminal-info fetch failed:', err);
        setStatus('error');
        setErrorMsg(`Failed to resolve TUI: ${(err as Error).message}`);
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
            return;
          }
          if (msg.type === 'exit') {
            console.debug('[terminal] process exited: code=%d signal=%s', msg.exitCode, msg.signal);
            activeSessionIdRef.current = null;
            setStatus('disconnected');
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

      // Terminal output
      activeTerm.write(data);

      // Inject responses for terminal queries that ghostty-web doesn't handle
      if (typeof data === 'string' && data.includes('\x1b')) {
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
        <span className="text-sm font-medium" style={{ color: 'var(--color-text-primary, #e0e0e0)' }}>
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
          className="text-xs px-2 py-1 rounded transition-colors"
          style={{ color: 'var(--color-text-muted, rgba(255,255,255,0.5))' }}
          title="Reconnect to existing session"
        >
          Reconnect
        </button>
        {mode === 'embedded' ? (
          <Link
            to="/swarms"
            className="text-xs px-2 py-1 rounded transition-colors hover:opacity-80"
            style={{ color: 'var(--color-text-muted, rgba(255,255,255,0.5))' }}
          >
            &larr; Back to Swarms
          </Link>
        ) : (
          <button
            onClick={onClose}
            className="px-2 py-1 rounded transition-colors"
            style={{ color: 'var(--color-text-muted, rgba(255,255,255,0.5))' }}
            title="Close terminal"
          >
            &times;
          </button>
        )}
      </div>
    </div>
  );

  const errorBanner = errorMsg && (
    <div className="px-4 py-2 bg-red-900/30 border-b border-red-500/20 text-red-300 text-xs">
      {errorMsg}
    </div>
  );

  const terminalContainer = <div ref={containerRef} className="flex-1 min-h-0 p-1" />;

  if (mode === 'embedded') {
    return (
      <div
        className="h-full flex flex-col"
        style={{ backgroundColor: '#0a0a0f' }}
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
        className="w-full max-w-5xl flex flex-col rounded-t-xl shadow-2xl border"
        style={{
          height: '60vh',
          backgroundColor: '#0a0a0f',
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

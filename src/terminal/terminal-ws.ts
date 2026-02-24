/**
 * Terminal WebSocket Handler
 *
 * Handles WebSocket connections for terminal sessions, bridging
 * browser-side ghostty-web to server-side PTY processes.
 *
 * Protocol:
 *   Client -> Server:
 *     - Raw string data: forwarded to PTY stdin
 *     - JSON { type: "resize", cols: number, rows: number }: resize PTY
 *
 *   Server -> Client:
 *     - Raw string data: PTY stdout output
 *     - JSON { type: "connected", sessionId: string }: session attached
 *     - JSON { type: "exit", exitCode: number, signal?: number }: session ended
 *     - JSON { type: "error", message: string }: error occurred
 *
 * Adapted from references/swarmcraft/src/server/terminal/terminal-ws.ts
 */

import { WebSocket } from 'ws';
import type { PtyManager, TerminalSessionConfig } from './pty-manager.js';

interface TerminalWSClient {
  socket: WebSocket;
  sessionId: string;
  dataListener: (event: { sessionId: string; data: string }) => void;
  exitListener: (event: { sessionId: string; exitCode: number; signal?: number }) => void;
}

const activeClients: Map<string, TerminalWSClient> = new Map();

/** Only allow environment variable keys matching these prefixes */
const ALLOWED_ENV_PREFIXES = ['MAP_', 'OPENSWARM_', 'OPENHIVE_', 'TERM', 'LANG', 'LC_'];

/** Only allow commands matching these patterns (security) */
function isAllowedCommand(command: string): boolean {
  // Standard shells
  if (['/bin/bash', '/bin/zsh', '/bin/sh', 'bash', 'zsh', 'sh'].includes(command)) {
    return true;
  }
  // OpenSwarm TUI binary paths
  if (command.includes('@openswarm/cli-') || command.includes('packages/cli-')) {
    return true;
  }
  // User's default shell
  if (command === process.env.SHELL) {
    return true;
  }
  return false;
}

/**
 * Handle a new terminal WebSocket connection.
 * Query params can include: cols, rows, command, args, cwd, sessionId, env
 */
export function handleTerminalWebSocket(
  socket: WebSocket,
  query: {
    cols?: string;
    rows?: string;
    command?: string;
    args?: string;
    cwd?: string;
    sessionId?: string;
    env?: string;
  },
  ptyManager: PtyManager,
): void {
  console.log('[terminal-ws] new connection, query:', JSON.stringify(query));

  // If a sessionId is provided, attach to an existing session
  const existingSessionId = query.sessionId;

  let sessionId: string;

  if (existingSessionId) {
    const info = ptyManager.getInfo(existingSessionId);
    console.log('[terminal-ws] attaching to session %s, info:', existingSessionId, info ? `status=${info.status}` : 'NOT_FOUND');
    if (!info || info.status !== 'running') {
      socket.send(JSON.stringify({ type: 'error', message: 'Session not found or not running' }));
      socket.close();
      return;
    }
    sessionId = existingSessionId;
  } else {
    // Parse env if provided (JSON-encoded key-value pairs), whitelist keys
    let env: Record<string, string> | undefined;
    if (query.env) {
      try {
        const raw = JSON.parse(query.env);
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const filtered: Record<string, string> = {};
          for (const [key, value] of Object.entries(raw)) {
            if (
              typeof value === 'string' &&
              ALLOWED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
            ) {
              filtered[key] = value;
            }
          }
          if (Object.keys(filtered).length > 0) {
            env = filtered;
          }
        }
      } catch {
        // Ignore invalid env JSON
      }
    }

    // Parse args: support JSON array or legacy comma-separated
    let parsedArgs: string[] | undefined;
    if (query.args) {
      if (query.args.startsWith('[')) {
        try {
          parsedArgs = JSON.parse(query.args);
        } catch {
          parsedArgs = query.args.split(',');
        }
      } else {
        parsedArgs = query.args.split(',');
      }
    }

    // Parse and validate dimensions
    const cols = query.cols ? parseInt(query.cols, 10) : undefined;
    const rows = query.rows ? parseInt(query.rows, 10) : undefined;

    // Validate command against allowlist
    const command = query.command || undefined;
    console.log('[terminal-ws] command=%s, args=%o, allowed=%s', command, parsedArgs, command ? isAllowedCommand(command) : 'N/A (default shell)');
    if (command && !isAllowedCommand(command)) {
      socket.send(JSON.stringify({ type: 'error', message: 'Command not allowed' }));
      socket.close();
      return;
    }

    // Create a new PTY session
    const config: TerminalSessionConfig = {
      cols: cols && cols > 0 && cols <= 500 ? cols : undefined,
      rows: rows && rows > 0 && rows <= 200 ? rows : undefined,
      command,
      args: parsedArgs,
      cwd: query.cwd || undefined,
      env,
    };

    console.log('[terminal-ws] creating PTY session with config:', JSON.stringify(config));
    try {
      const info = ptyManager.create(config);
      sessionId = info.id;
      console.log('[terminal-ws] PTY session created: id=%s pid=%d', info.id, info.pid);
    } catch (err) {
      console.error('[terminal-ws] PTY create failed:', err);
      socket.send(
        JSON.stringify({ type: 'error', message: (err as Error).message }),
      );
      socket.close();
      return;
    }
  }

  // Set up data forwarding: PTY -> WebSocket
  const dataListener = (event: { sessionId: string; data: string }) => {
    if (event.sessionId === sessionId && socket.readyState === WebSocket.OPEN) {
      socket.send(event.data);
    }
  };

  const exitListener = (event: { sessionId: string; exitCode: number; signal?: number }) => {
    if (event.sessionId === sessionId && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'exit', exitCode: event.exitCode, signal: event.signal }));
    }
  };

  ptyManager.on('session.data', dataListener);
  ptyManager.on('session.exit', exitListener);

  const clientId = sessionId + '-' + Date.now();
  activeClients.set(clientId, { socket, sessionId, dataListener, exitListener });

  // Send session info to client
  console.log('[terminal-ws] sending connected message for session %s', sessionId);
  socket.send(JSON.stringify({ type: 'connected', sessionId }));

  // Handle incoming messages from the client
  socket.on('message', (rawData) => {
    const data = rawData.toString();

    // Try to parse as JSON for control messages
    if (data.startsWith('{')) {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          const c = Math.floor(msg.cols);
          const r = Math.floor(msg.rows);
          if (c > 0 && c <= 500 && r > 0 && r <= 200) {
            ptyManager.resize(sessionId, c, r);
          }
          return;
        }
      } catch {
        // Not JSON, treat as terminal input
      }
    }

    // Forward raw input to PTY
    try {
      ptyManager.write(sessionId, data);
    } catch {
      // Session may have been destroyed
    }
  });

  // Handle WebSocket close
  socket.on('close', () => {
    console.log('[terminal-ws] client disconnected: %s (session %s)', clientId, sessionId);
    ptyManager.removeListener('session.data', dataListener);
    ptyManager.removeListener('session.exit', exitListener);
    activeClients.delete(clientId);

    // If no other clients are attached to this session and it wasn't a pre-existing attach,
    // destroy the session after a grace period
    if (!existingSessionId) {
      const hasOtherClients = Array.from(activeClients.values()).some(
        (c) => c.sessionId === sessionId,
      );
      if (!hasOtherClients) {
        setTimeout(() => {
          // Re-check after grace period
          const stillHasClients = Array.from(activeClients.values()).some(
            (c) => c.sessionId === sessionId,
          );
          if (!stillHasClients) {
            try {
              ptyManager.destroy(sessionId);
            } catch {
              // Already destroyed
            }
          }
        }, 5000);
      }
    }
  });

  socket.on('error', () => {
    ptyManager.removeListener('session.data', dataListener);
    ptyManager.removeListener('session.exit', exitListener);
    activeClients.delete(clientId);
  });
}

#!/usr/bin/env node
/**
 * Mock MAP server for e2e tests.
 *
 * Accepts --port <N> and serves:
 *   - WebSocket on /map (MAP protocol — accepts connections, responds to connect handshake)
 *   - WebSocket on /acp (ACP protocol — accepts connections)
 *   - HTTP GET /health on port N+1 (OpenSwarm gateway convention)
 *
 * This simulates enough of an OpenSwarm combined-server for e2e testing
 * without requiring the real macro-agent or OpenSwarm packages.
 */

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const portIdx = process.argv.indexOf('--port');
const port = portIdx !== -1 ? parseInt(process.argv[portIdx + 1], 10) : 9999;
const healthPort = port + 1;

// ===========================================================================
// Main WebSocket server (port) — handles /map and /acp upgrade paths
// ===========================================================================

const httpServer = http.createServer((req, res) => {
  res.writeHead(404);
  res.end('Not Found');
});

const mapWss = new WebSocketServer({ noServer: true });
const acpWss = new WebSocketServer({ noServer: true });

// MAP protocol: minimal handshake
mapWss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      // Respond to JSON-RPC connect request
      if (msg.method === 'map/connect') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: 'test-session-' + Date.now(),
            peerId: 'mock-map-server',
            capabilities: {
              observation: true,
              messaging: true,
              lifecycle: true,
            },
          },
        }));
      } else {
        // Echo back a generic result for any other method
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {},
        }));
      }
    } catch {
      // Not JSON — ignore
    }
  });
});

// ACP protocol: accept connections (minimal)
acpWss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {},
      }));
    } catch {
      // ignore
    }
  });
});

// Route WebSocket upgrades by path
httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://localhost:${port}`);
  const pathname = url.pathname;

  if (pathname === '/map') {
    mapWss.handleUpgrade(request, socket, head, (ws) => {
      mapWss.emit('connection', ws, request);
    });
  } else if (pathname === '/acp') {
    acpWss.handleUpgrade(request, socket, head, (ws) => {
      acpWss.emit('connection', ws, request);
    });
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

httpServer.listen(port, '127.0.0.1', () => {
  // MAP/ACP ready
});

// ===========================================================================
// Health HTTP server (port+1) — matches OpenSwarm gateway convention
// ===========================================================================

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      gateway: 'running',
      adapter: 'running',
      map_port: port,
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

healthServer.listen(healthPort, '127.0.0.1', () => {
  // Health endpoint ready
});

// ===========================================================================
// Graceful shutdown
// ===========================================================================

function shutdown() {
  mapWss.close();
  acpWss.close();
  httpServer.close();
  healthServer.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Stay alive for 5 minutes (tests should stop us before that)
setTimeout(() => {
  process.exit(0);
}, 300000);

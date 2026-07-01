#!/usr/bin/env node
/**
 * Mock Learning Swarm Server for E2E Tests
 *
 * Extends the base mock MAP server with learning workspace execution support.
 * When receiving x-openhive/learning.workspace.execute, it:
 *   1. Reads the workspace prompt and cwd
 *   2. Writes output files to the workspace (if cwd exists)
 *   3. Sends back x-openhive/learning.workspace.result
 *
 * Also connects BACK to the OpenHive MAP hub to register as a connected swarm.
 */

// Package.json sets `"type": "module"`, so this fixture must use ESM
// imports rather than `require()`.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';

const portIdx = process.argv.indexOf('--port');
const port = portIdx !== -1 ? parseInt(process.argv[portIdx + 1], 10) : 9999;
const healthPort = port + 1;

// Check for bootstrap token to auto-connect to hub
const bootstrapToken = process.env.SWARM_RUNNER_BOOTSTRAP_TOKEN;
let hubWs = null;

// ===========================================================================
// Main WebSocket server (serves as SwarmRunner MAP endpoint)
// ===========================================================================

const httpServer = http.createServer((req, res) => {
  res.writeHead(404);
  res.end('Not Found');
});

const mapWss = new WebSocketServer({ noServer: true });
const acpWss = new WebSocketServer({ noServer: true });

mapWss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.method === 'map/connect') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: 'learning-session-' + Date.now(),
            peerId: 'learning-swarm-mock',
            capabilities: {
              observation: true,
              messaging: true,
              lifecycle: true,
            },
          },
        }));
      } else if (msg.method === 'x-workspace/task.execute' || msg.method === 'x-openhive/learning.workspace.execute') {
        // Handle workspace execution request
        handleWorkspaceExecute(ws, msg);
      } else if (msg.id !== undefined) {
        // Generic RPC response
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {},
        }));
      }
    } catch (e) {
      // Not JSON or parse error — ignore
    }
  });
});

/**
 * Handle a workspace.execute request from OpenHive.
 * Simulates agent execution by writing output files and returning results.
 */
function handleWorkspaceExecute(ws, msg) {
  const params = msg.params || {};
  const requestId = params.request_id;
  const prompt = params.prompt || '';
  const cwd = params.cwd;

  console.log(`[learning-swarm] Received workspace.execute: ${requestId}`);
  console.log(`[learning-swarm] Prompt: ${prompt.substring(0, 100)}...`);
  console.log(`[learning-swarm] CWD: ${cwd}`);

  // Simulate agent analysis output
  const output = {
    analysis: 'Mock analysis of workspace template',
    playbooks: [
      {
        name: 'mock-playbook',
        applicability: { domains: ['test'], situations: ['testing workspace execution'] },
        guidance: { strategy: 'Mock strategy from live swarm' },
        confidence: 0.5,
      },
    ],
  };

  // If cwd exists, write output files (simulating what a real agent would do)
  if (cwd && fs.existsSync(cwd)) {
    const outputDir = path.join(cwd, 'output');
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(
        path.join(outputDir, 'analysis.json'),
        JSON.stringify(output, null, 2),
      );
      console.log(`[learning-swarm] Wrote output to ${outputDir}/analysis.json`);
    } catch (e) {
      console.warn(`[learning-swarm] Failed to write output: ${e.message}`);
    }
  }

  // Send result back
  const response = {
    jsonrpc: '2.0',
    method: 'x-workspace/task.result',
    params: {
      request_id: requestId,
      success: true,
      output: JSON.stringify(output),
      structured: output,
      duration_ms: 150,
    },
  };

  ws.send(JSON.stringify(response));
  console.log(`[learning-swarm] Sent workspace.result for ${requestId}`);
}

// ACP protocol (minimal)
acpWss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
    } catch { /* ignore */ }
  });
});

// Route upgrades
httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://localhost:${port}`);
  if (url.pathname === '/map') {
    mapWss.handleUpgrade(request, socket, head, (ws) => mapWss.emit('connection', ws, request));
  } else if (url.pathname === '/acp') {
    acpWss.handleUpgrade(request, socket, head, (ws) => acpWss.emit('connection', ws, request));
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

httpServer.listen(port, '127.0.0.1', () => {
  process.stderr.write(`[learning-swarm] MAP server listening on port ${port}\n`);
  process.stderr.write(`[learning-swarm] Bootstrap token present: ${!!bootstrapToken}\n`);

  // Auto-connect to OpenHive hub if bootstrap token is present
  if (bootstrapToken) {
    connectToHub(bootstrapToken);
  } else {
    process.stderr.write('[learning-swarm] No bootstrap token — skipping hub connection\n');
  }
});

// ===========================================================================
// Health endpoint
// ===========================================================================

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', gateway: 'running', adapter: 'running', map_port: port }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

healthServer.listen(healthPort, '127.0.0.1', () => {
  console.log(`[learning-swarm] Health server on port ${healthPort}`);
});

// ===========================================================================
// Auto-connect to OpenHive hub
// ===========================================================================

function connectToHub(token) {
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString());
    const hubUrl = decoded.openhive_url;
    const onboardToken = decoded.onboard_token;
    const swarmName = decoded.swarm_name || 'learning-mock';

    if (!hubUrl) {
      console.log('[learning-swarm] No hub URL in bootstrap token');
      return;
    }

    const wsUrl = `${hubUrl.replace('http', 'ws')}/ws/map?token=${onboardToken}&swarm_id=${swarmName}`;
    console.log(`[learning-swarm] Connecting to hub: ${wsUrl}`);

    hubWs = new WebSocket(wsUrl);

    hubWs.on('open', () => {
      console.log('[learning-swarm] Connected to hub');
    });

    hubWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        process.stderr.write(`[learning-swarm] hubWs message: method=${msg.method}\n`);
        if (msg.method === 'hub/welcome') {
          process.stderr.write(`[learning-swarm] Hub welcome received\n`);
        } else if (msg.method === 'x-workspace/task.execute' || msg.method === 'x-openhive/learning.workspace.execute') {
          process.stderr.write(`[learning-swarm] Handling workspace.execute\n`);
          handleWorkspaceExecuteFromHub(msg);
        } else {
          process.stderr.write(`[learning-swarm] Unhandled method: ${msg.method}\n`);
        }
      } catch (e) {
        process.stderr.write(`[learning-swarm] hubWs message parse error: ${e.message}\n`);
      }
    });

    hubWs.on('error', (err) => {
      console.warn(`[learning-swarm] Hub connection error: ${err.message}`);
    });

    hubWs.on('close', () => {
      console.log('[learning-swarm] Hub connection closed');
    });
  } catch (e) {
    console.warn(`[learning-swarm] Failed to parse bootstrap token: ${e.message}`);
  }
}

function handleWorkspaceExecuteFromHub(msg) {
  if (!hubWs || hubWs.readyState !== WebSocket.OPEN) return;

  const params = msg.params || {};
  const requestId = params.request_id;
  const cwd = params.cwd;
  const prompt = params.prompt || '';
  console.log(`[learning-swarm] Hub workspace.execute: ${requestId}, cwd: ${cwd}`);

  // Write output files matching the exact schema cognitive-core expects.
  // Detect which template is being run from the workspace directory name.
  if (cwd) {
    try {
      const outputDir = path.join(cwd, 'output');
      fs.mkdirSync(outputDir, { recursive: true });

      if (cwd.includes('trajectory-analysis') || prompt.includes('trajectory')) {
        // Schema expected by trajectoryAnalysisTemplate.collectOutput():
        // { success, keySteps, stepAttribution, errorPatterns, abstractable, trainingExamples }
        fs.writeFileSync(path.join(outputDir, 'analysis.json'), JSON.stringify({
          success: true,
          keySteps: [0, 1],
          stepAttribution: [0.8, 0.7],
          errorPatterns: [],
          abstractable: true,
          trainingExamples: [],
        }, null, 2));
        console.log(`[learning-swarm] Wrote analysis.json (trajectory-analysis schema)`);
      } else if (cwd.includes('playbook-extraction') || prompt.includes('playbook')) {
        // Schema expected by playbookExtractionTemplate.collectOutput():
        // { new: [{ name, strategy, tactics, situations, triggers, antiPatterns, domains, confidence }], updates: [] }
        fs.writeFileSync(path.join(outputDir, 'extraction.json'), JSON.stringify({
          new: [{
            name: 'mock-error-handling',
            strategy: 'Wrap API calls in try-catch blocks',
            tactics: ['Identify unhandled calls', 'Add try-catch', 'Return proper error responses'],
            situations: ['API endpoints without error handling'],
            triggers: ['No try-catch', 'unhandled promise'],
            antiPatterns: ['Silencing errors without logging'],
            domains: ['api', 'error-handling'],
            confidence: 0.6,
          }],
          updates: [],
        }, null, 2));
        console.log(`[learning-swarm] Wrote extraction.json (playbook-extraction schema)`);
      } else {
        // Generic output for unknown templates
        fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify({
          success: true,
          output: 'Generic mock output',
        }, null, 2));
        console.log(`[learning-swarm] Wrote generic result.json`);
      }
    } catch (e) {
      console.warn(`[learning-swarm] Failed to write output to cwd: ${e.message}`);
    }
  }

  hubWs.send(JSON.stringify({
    jsonrpc: '2.0',
    method: 'x-workspace/task.result',
    params: {
      request_id: requestId,
      success: true,
      output: JSON.stringify(output),
      structured: output,
      duration_ms: 100,
    },
  }));
}

// ===========================================================================
// Graceful shutdown
// ===========================================================================

function shutdown() {
  if (hubWs) hubWs.close();
  mapWss.close();
  acpWss.close();
  httpServer.close();
  healthServer.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
setTimeout(() => process.exit(0), 300000);

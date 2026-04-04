#!/usr/bin/env node
/**
 * Mock Classifier Swarm Server for E2E Tests
 *
 * Handles workspace.execute requests by detecting whether the prompt is for
 * skill classification or relationship detection, then writes appropriate
 * JSON output to the workspace output/ directory and sends the result back.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const portIdx = process.argv.indexOf('--port');
const port = portIdx !== -1 ? parseInt(process.argv[portIdx + 1], 10) : 9999;
const healthPort = port + 1;

const bootstrapToken = process.env.OPENSWARM_BOOTSTRAP_TOKEN;
let hubWs = null;

// ===========================================================================
// Classification response generators
// ===========================================================================

function generateClassificationResponse(prompt) {
  // Extract skill name from prompt
  const nameMatch = prompt.match(/Name:\s*(.+)/);
  const name = nameMatch ? nameMatch[1].trim() : 'unknown-skill';

  // Simple keyword-based classification
  const lowerPrompt = prompt.toLowerCase();
  let primaryPath;

  if (lowerPrompt.includes('react') || lowerPrompt.includes('frontend') || lowerPrompt.includes('component')) {
    primaryPath = ['Development', 'Frontend', 'React'];
  } else if (lowerPrompt.includes('express') || lowerPrompt.includes('middleware') || lowerPrompt.includes('backend')) {
    primaryPath = ['Development', 'Backend', 'Node.js'];
  } else if (lowerPrompt.includes('typescript') || lowerPrompt.includes('generics') || lowerPrompt.includes('type')) {
    primaryPath = ['Development', 'Languages', 'TypeScript'];
  } else if (lowerPrompt.includes('docker') || lowerPrompt.includes('container')) {
    primaryPath = ['Infrastructure', 'Containers', 'Docker'];
  } else if (lowerPrompt.includes('machine learning') || lowerPrompt.includes('llm')) {
    primaryPath = ['AI-ML', 'LLMs'];
  } else {
    primaryPath = ['Development', 'General'];
  }

  return {
    primaryPath,
    secondaryPaths: [],
    confidence: 0.85,
    reasoning: `Classified "${name}" based on content analysis.`,
    suggestedTags: [primaryPath[primaryPath.length - 1].toLowerCase()],
    suggestedNewCategories: [],
    relationships: [],
  };
}

function generateRelationshipResponse(prompt) {
  const skill1Match = prompt.match(/## Skill 1:\s*(.+)/);
  const skill2Match = prompt.match(/## Skill 2:\s*(.+)/);
  const skill1 = skill1Match ? skill1Match[1].trim() : '';
  const skill2 = skill2Match ? skill2Match[1].trim() : '';

  // Detect some simple relationships
  const lower = prompt.toLowerCase();
  const bothFrontend = lower.includes('react') && lower.includes('typescript');
  const bothBackend = lower.includes('express') && lower.includes('middleware');

  if (bothFrontend || bothBackend) {
    return {
      hasRelationship: true,
      type: 'related',
      strength: 0.7,
      reasoning: `"${skill1}" and "${skill2}" are commonly used together.`,
    };
  }

  return {
    hasRelationship: false,
    type: 'related',
    strength: 0.0,
    reasoning: 'No strong relationship detected.',
  };
}

// ===========================================================================
// Workspace execution handler
// ===========================================================================

function handleWorkspaceExecute(ws, msg) {
  const params = msg.params || {};
  const requestId = params.request_id;
  const prompt = params.prompt || '';
  const cwd = params.cwd;

  process.stderr.write(`[classifier-swarm] Received workspace.execute: ${requestId}\n`);

  // Detect task type from prompt content
  const isClassification = prompt.includes('Skill to Classify') || prompt.includes('primaryPath');
  const isRelationship = prompt.includes('Skill 1:') && prompt.includes('Skill 2:') && prompt.includes('hasRelationship');

  let output;
  let outputFileName;

  if (isClassification) {
    output = generateClassificationResponse(prompt);
    outputFileName = 'classification.json';
    process.stderr.write(`[classifier-swarm] Classification task for: ${output.reasoning}\n`);
  } else if (isRelationship) {
    output = generateRelationshipResponse(prompt);
    outputFileName = 'relationship.json';
    process.stderr.write(`[classifier-swarm] Relationship task: ${output.reasoning}\n`);
  } else {
    output = { error: 'Unknown task type' };
    outputFileName = 'output.json';
    process.stderr.write(`[classifier-swarm] Unknown task type\n`);
  }

  // Write output to workspace if cwd exists
  if (cwd && fs.existsSync(cwd)) {
    const outputDir = path.join(cwd, 'output');
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(
        path.join(outputDir, outputFileName),
        JSON.stringify(output, null, 2),
      );
      process.stderr.write(`[classifier-swarm] Wrote ${outputDir}/${outputFileName}\n`);
    } catch (e) {
      process.stderr.write(`[classifier-swarm] Failed to write output: ${e.message}\n`);
    }
  }

  // Send result back via MAP
  ws.send(JSON.stringify({
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

  process.stderr.write(`[classifier-swarm] Sent result for ${requestId}\n`);
}

// ===========================================================================
// MAP WebSocket server
// ===========================================================================

const httpServer = http.createServer((req, res) => {
  res.writeHead(404);
  res.end('Not Found');
});

const mapWss = new WebSocketServer({ noServer: true });

mapWss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.method === 'map/connect') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: 'classifier-session-' + Date.now(),
            peerId: 'classifier-swarm-mock',
            capabilities: {
              observation: true,
              messaging: true,
              lifecycle: true,
            },
          },
        }));
      } else if (msg.method === 'x-workspace/task.execute' || msg.method === 'x-openhive/learning.workspace.execute') {
        handleWorkspaceExecute(ws, msg);
      } else if (msg.id !== undefined) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {},
        }));
      }
    } catch (e) {
      // ignore
    }
  });
});

httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://localhost:${port}`);
  if (url.pathname === '/map') {
    mapWss.handleUpgrade(request, socket, head, (ws) => mapWss.emit('connection', ws, request));
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

httpServer.listen(port, '127.0.0.1', () => {
  process.stderr.write(`[classifier-swarm] MAP server listening on port ${port}\n`);

  if (bootstrapToken) {
    connectToHub(bootstrapToken);
  } else {
    process.stderr.write('[classifier-swarm] No bootstrap token — skipping hub connection\n');
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
  process.stderr.write(`[classifier-swarm] Health endpoint on port ${healthPort}\n`);
});

// ===========================================================================
// Hub connection (auto-register as connected swarm)
// ===========================================================================

function connectToHub(token) {
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString());
    const hubUrl = decoded.openhive_url;
    const preauthKey = decoded.preauth_key;
    const swarmName = decoded.swarm_name || 'classifier-mock';

    if (!hubUrl) {
      process.stderr.write('[classifier-swarm] No hub URL in bootstrap token\n');
      return;
    }

    const wsUrl = `${hubUrl.replace('http', 'ws')}/ws/map?token=${preauthKey}&swarm_id=${swarmName}`;
    process.stderr.write(`[classifier-swarm] Connecting to hub: ${wsUrl}\n`);

    hubWs = new WebSocket(wsUrl);

    hubWs.on('open', () => {
      process.stderr.write('[classifier-swarm] Connected to hub\n');
    });

    hubWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Handle workspace execute requests coming through the hub connection
        if (msg.method === 'x-workspace/task.execute' || msg.method === 'x-openhive/learning.workspace.execute') {
          handleWorkspaceExecute(hubWs, msg);
        }
      } catch {
        // ignore
      }
    });

    hubWs.on('error', (err) => {
      process.stderr.write(`[classifier-swarm] Hub WS error: ${err.message}\n`);
    });

    hubWs.on('close', () => {
      process.stderr.write('[classifier-swarm] Hub connection closed\n');
    });
  } catch (e) {
    process.stderr.write(`[classifier-swarm] Failed to parse bootstrap token: ${e.message}\n`);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  process.stderr.write('[classifier-swarm] Shutting down...\n');
  if (hubWs) hubWs.close();
  httpServer.close();
  healthServer.close();
  process.exit(0);
});

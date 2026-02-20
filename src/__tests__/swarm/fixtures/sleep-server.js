#!/usr/bin/env node
// Simple test fixture: stays alive, serves a health endpoint, and optionally prints output.
// Used by LocalProvider and SwarmManager tests as a stand-in for OpenSwarm.
//
// Accepts --port <N> and serves /health on port N+1 (matching OpenSwarm gateway behavior).

const http = require('http');

const mode = process.argv.find(a => a === '--verbose');
const portIdx = process.argv.indexOf('--port');
const port = portIdx !== -1 ? parseInt(process.argv[portIdx + 1], 10) : null;

if (mode) {
  console.log('hello from swarm');
  console.error('err msg');
  for (let i = 0; i < 10; i++) {
    console.log('line' + i);
  }
}

// Serve /health on port+1 (OpenSwarm gateway convention)
if (port) {
  const healthPort = port + 1;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', gateway: 'running', adapter: 'running' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(healthPort, '127.0.0.1', () => {
    // Health endpoint ready
  });

  // Clean up on exit
  process.on('SIGTERM', () => {
    server.close();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    server.close();
    process.exit(0);
  });
}

// Stay alive for 60 seconds
setTimeout(() => {
  process.exit(0);
}, 60000);

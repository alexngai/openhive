#!/usr/bin/env node
/**
 * Test fixture: dumps a subset of env vars to a file (path from MACRO_TEST_ENV_DUMP),
 * then behaves like sleep-server (stays alive, serves /health on port+2 to satisfy
 * any lingering probes). Used by LocalProvider tests to verify env propagation.
 */

import http from 'node:http';
import fs from 'node:fs';

const dumpPath = process.env.MACRO_TEST_ENV_DUMP;
if (dumpPath) {
  // Capture the env vars we care about. JSON keeps key order + null-vs-undefined
  // distinct for assertions.
  const captured = {
    MACRO_BOOTSTRAP_COORDINATOR: process.env.MACRO_BOOTSTRAP_COORDINATOR ?? null,
    MACRO_BOOTSTRAP_CWD: process.env.MACRO_BOOTSTRAP_CWD ?? null,
    OPENSWARM_BOOTSTRAP_TOKEN: process.env.OPENSWARM_BOOTSTRAP_TOKEN ? 'set' : null,
    OPENSWARM_DATA_DIR: process.env.OPENSWARM_DATA_DIR ?? null,
  };
  try {
    fs.writeFileSync(dumpPath, JSON.stringify(captured));
  } catch (err) {
    console.error('env-dump: failed to write', err.message);
    process.exit(1);
  }
}

const portIdx = process.argv.indexOf('--port');
const port = portIdx !== -1 ? parseInt(process.argv[portIdx + 1], 10) : null;
if (port) {
  const healthPort = port + 1;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(healthPort);
}

// Stay alive until killed.
setInterval(() => {}, 60_000);

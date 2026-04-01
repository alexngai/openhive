#!/usr/bin/env node
/**
 * Starts an OpenHive server in a child process for e2e testing.
 *
 * Accepts configuration via OPENHIVE_E2E_CONFIG env var (JSON string).
 * Writes "READY:<port>" to stdout when the server is listening.
 * Writes "ERROR:<message>" to stderr on failure.
 *
 * Usage:
 *   OPENHIVE_E2E_CONFIG='{"port":19899,...}' node start-server.js
 */

const path = require('path');

async function main() {
  try {
    const configJson = process.env.OPENHIVE_E2E_CONFIG;
    if (!configJson) {
      process.stderr.write('ERROR:OPENHIVE_E2E_CONFIG env var required\n');
      process.exit(1);
    }

    const config = JSON.parse(configJson);

    // Initialize database
    const { initDatabase } = require(path.resolve(__dirname, '../../../db/index.js'));
    initDatabase(config.database);

    // Import server
    const { createHive } = require(path.resolve(__dirname, '../../../server.js'));

    const server = await createHive(config);
    await server.start();

    // Signal ready
    process.stdout.write(`READY:${config.port}\n`);

    // Handle shutdown
    const shutdown = async () => {
      try {
        await server.stop();
      } catch { /* ignore */ }
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    // Keep alive
    setTimeout(() => {
      process.stderr.write('ERROR:Server timeout (5min)\n');
      process.exit(1);
    }, 300_000);
  } catch (err) {
    process.stderr.write(`ERROR:${err.message}\n`);
    process.exit(1);
  }
}

main();

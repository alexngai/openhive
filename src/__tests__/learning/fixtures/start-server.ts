/**
 * Server bootstrap for e2e tests.
 *
 * Reads config from OPENHIVE_E2E_CONFIG_PATH env var.
 * Prints "E2E_SERVER_READY" to stdout when ready.
 * Prints "E2E_SERVER_ERROR:<msg>" to stderr on failure.
 */

import { readFileSync } from 'fs';
import { initDatabase } from '../../../db/index.js';
import { createHive } from '../../../server.js';

const configPath = process.env.OPENHIVE_E2E_CONFIG_PATH;
if (!configPath) {
  console.error('E2E_SERVER_ERROR:OPENHIVE_E2E_CONFIG_PATH required');
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf-8'));

async function main() {
  initDatabase(config.database);
  const server = await createHive(config);
  await server.start();

  console.log('E2E_SERVER_READY');

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  console.error(`E2E_SERVER_ERROR:${err.message}`);
  process.exit(1);
});

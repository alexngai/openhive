#!/usr/bin/env node

// openhive-headless: server-only entry point.
// Defaults OPENHIVE_MODE=server so the hub skips the SPA mount entirely
// (see src/server.ts headless branch). Explicit OPENHIVE_MODE wins.
process.env.OPENHIVE_MODE = process.env.OPENHIVE_MODE ?? 'server';
import('../dist/cli.js');

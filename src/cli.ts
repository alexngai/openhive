#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { createHive } from './server.js';
import { generateSampleConfig } from './config.js';
import { initDatabase, getDatabase, closeDatabase } from './db/index.js';
import { createInviteCode } from './db/dal/invites.js';
import { createAgent } from './db/dal/agents.js';
import { nanoid } from 'nanoid';
import { registerNetworkCommands } from './cli/network.js';

const program = new Command();

program
  .name('openhive')
  .description('OpenHive - A self-hostable social network for AI agents')
  .version('0.1.0');

// Serve command
program
  .command('serve')
  .description('Start the OpenHive server')
  .option('-p, --port <port>', 'Port to listen on', '3000')
  .option('-h, --host <host>', 'Host to bind to', '0.0.0.0')
  .option('-d, --database <path>', 'Database file path', './data/openhive.db')
  .option('-c, --config <path>', 'Config file path')
  .option('--admin-key <key>', 'Admin API key')
  .action(async (options) => {
    console.log(`
  ██████╗ ██████╗ ███████╗███╗   ██╗██╗  ██╗██╗██╗   ██╗███████╗
 ██╔═══██╗██╔══██╗██╔════╝████╗  ██║██║  ██║██║██║   ██║██╔════╝
 ██║   ██║██████╔╝█████╗  ██╔██╗ ██║███████║██║██║   ██║█████╗
 ██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║██╔══██║██║╚██╗ ██╔╝██╔══╝
 ╚██████╔╝██║     ███████╗██║ ╚████║██║  ██║██║ ╚████╔╝ ███████╗
  ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═══╝  ╚══════╝
`);

    // Set environment variables from options
    if (options.port) process.env.OPENHIVE_PORT = options.port;
    if (options.host) process.env.OPENHIVE_HOST = options.host;
    if (options.database) process.env.OPENHIVE_DATABASE = options.database;
    if (options.adminKey) process.env.OPENHIVE_ADMIN_KEY = options.adminKey;

    try {
      const server = await createHive(options.config);
      const address = await server.start();

      console.log(`\n🐝 OpenHive is running at ${address}`);
      console.log(`📖 API docs: ${address}/skill.md`);
      console.log(`🔧 Admin panel: ${address}/admin`);
      console.log(`🔌 WebSocket: ws://${address.replace('http://', '')}/ws`);
      console.log(`\nPress Ctrl+C to stop\n`);

      // Handle shutdown
      const shutdown = async () => {
        console.log('\n\nShutting down...');
        await server.stop();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  });

// Init command
program
  .command('init')
  .description('Create a sample configuration file')
  .option('-o, --output <path>', 'Output file path', 'openhive.config.js')
  .action((options) => {
    const outputPath = path.resolve(options.output);

    if (fs.existsSync(outputPath)) {
      console.error(`Error: ${outputPath} already exists`);
      process.exit(1);
    }

    fs.writeFileSync(outputPath, generateSampleConfig());
    console.log(`Created configuration file: ${outputPath}`);
  });

// Admin commands
const admin = program.command('admin').description('Admin utilities');

admin
  .command('create-key')
  .description('Generate a new admin key')
  .action(() => {
    const key = nanoid(32);
    console.log(`\nGenerated admin key: ${key}`);
    console.log(`\nSet it in your config or environment:`);
    console.log(`  export OPENHIVE_ADMIN_KEY="${key}"`);
  });

admin
  .command('create-invite')
  .description('Generate an invite code')
  .option('-d, --database <path>', 'Database file path', './data/openhive.db')
  .option('-u, --uses <number>', 'Number of uses', '1')
  .action((options) => {
    initDatabase(options.database);

    const invite = createInviteCode({
      uses_left: parseInt(options.uses, 10),
    });

    console.log(`\nCreated invite code: ${invite.code}`);
    console.log(`Uses remaining: ${invite.uses_left}`);

    closeDatabase();
  });

admin
  .command('create-agent')
  .description('Create an agent directly')
  .option('-d, --database <path>', 'Database file path', './data/openhive.db')
  .requiredOption('-n, --name <name>', 'Agent name')
  .option('--admin', 'Make this agent an admin')
  .option('--description <desc>', 'Agent description')
  .action(async (options) => {
    initDatabase(options.database);

    const { agent, apiKey } = await createAgent({
      name: options.name,
      description: options.description,
      is_admin: options.admin,
    });

    console.log(`\nCreated agent: ${agent.name}`);
    console.log(`Agent ID: ${agent.id}`);
    console.log(`API Key: ${apiKey}`);
    if (options.admin) {
      console.log(`Admin: Yes`);
    }

    closeDatabase();
  });

// Database commands
const db = program.command('db').description('Database utilities');

db
  .command('migrate')
  .description('Run database migrations')
  .option('-d, --database <path>', 'Database file path', './data/openhive.db')
  .action((options) => {
    console.log('Running migrations...');
    initDatabase(options.database);
    console.log('Migrations complete.');
    closeDatabase();
  });

db
  .command('stats')
  .description('Show database statistics')
  .option('-d, --database <path>', 'Database file path', './data/openhive.db')
  .action((options) => {
    initDatabase(options.database);
    const db = getDatabase();

    const agents = db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number };
    const hives = db.prepare('SELECT COUNT(*) as count FROM hives').get() as { count: number };
    const posts = db.prepare('SELECT COUNT(*) as count FROM posts').get() as { count: number };
    const comments = db.prepare('SELECT COUNT(*) as count FROM comments').get() as { count: number };

    console.log(`\nDatabase: ${options.database}`);
    console.log(`Agents: ${agents.count}`);
    console.log(`Hives: ${hives.count}`);
    console.log(`Posts: ${posts.count}`);
    console.log(`Comments: ${comments.count}`);

    closeDatabase();
  });

db
  .command('seed')
  .description('Seed database with sample data')
  .option('-d, --database <path>', 'Database file path', './data/openhive.db')
  .action(async (options) => {
    initDatabase(options.database);

    console.log('Seeding database with sample data...');

    // Create a sample agent
    const { agent, apiKey } = await createAgent({
      name: 'demo-agent',
      description: 'A demo agent for testing',
    });

    console.log(`Created agent: ${agent.name} (API Key: ${apiKey})`);

    // Create some invite codes
    for (let i = 0; i < 3; i++) {
      const invite = createInviteCode({ uses_left: 5 });
      console.log(`Created invite code: ${invite.code}`);
    }

    console.log('Seed complete.');
    closeDatabase();
  });

// Network commands (mesh networking setup)
registerNetworkCommands(program);

program.parse();

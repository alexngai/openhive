#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { createHive } from './server.js';
import { generateSampleConfig } from './config.js';
import { initDatabase, getDatabase, closeDatabase } from './db/index.js';
import { createInviteCode } from './db/dal/invites.js';
import { createAgent } from './db/dal/agents.js';
import { nanoid } from 'nanoid';
import { registerNetworkCommands } from './cli/network.js';
import {
  resolveDataDir,
  ensureDataDir,
  dataDirPaths,
  isInitialised,
  findConfigFile,
} from './data-dir.js';

// ============================================================================
// Banner
// ============================================================================

const BANNER = `
  ██████╗ ██████╗ ███████╗███╗   ██╗██╗  ██╗██╗██╗   ██╗███████╗
 ██╔═══██╗██╔══██╗██╔════╝████╗  ██║██║  ██║██║██║   ██║██╔════╝
 ██║   ██║██████╔╝█████╗  ██╔██╗ ██║███████║██║██║   ██║█████╗
 ██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║██╔══██║██║╚██╗ ██╔╝██╔══╝
 ╚██████╔╝██║     ███████╗██║ ╚████║██║  ██║██║ ╚████╔╝ ███████╗
  ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═══╝  ╚══════╝
`;

// ============================================================================
// Interactive prompt helpers
// ============================================================================

function createPrompt(): {
  ask(question: string, defaultValue?: string): Promise<string>;
  choose(question: string, options: string[], defaultIndex?: number): Promise<number>;
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
  close(): void;
} {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return {
    ask(question: string, defaultValue?: string): Promise<string> {
      const suffix = defaultValue ? ` [${defaultValue}]` : '';
      return new Promise((resolve) => {
        rl.question(`${question}${suffix}: `, (answer) => {
          resolve(answer.trim() || defaultValue || '');
        });
      });
    },

    async choose(question: string, options: string[], defaultIndex = 0): Promise<number> {
      console.log(`\n${question}`);
      options.forEach((opt, i) => {
        const marker = i === defaultIndex ? '>' : ' ';
        console.log(`  ${marker} ${i + 1}) ${opt}`);
      });

      while (true) {
        const answer = await this.ask(`  Choice`, String(defaultIndex + 1));
        const num = parseInt(answer, 10);
        if (num >= 1 && num <= options.length) return num - 1;
        console.log(`  Please enter a number between 1 and ${options.length}.`);
      }
    },

    async confirm(question: string, defaultValue = true): Promise<boolean> {
      const hint = defaultValue ? 'Y/n' : 'y/N';
      const answer = await this.ask(`${question} (${hint})`);
      if (!answer) return defaultValue;
      return answer.toLowerCase().startsWith('y');
    },

    close() {
      rl.close();
    },
  };
}

// ============================================================================
// Non-interactive init overrides
// ============================================================================

interface InitOverrides {
  name?: string;
  port?: number;
  authMode?: string;
  verification?: string;
}

// ============================================================================
// Setup wizard
// ============================================================================

async function runSetupWizard(explicitDataDir?: string, overrides: InitOverrides = {}): Promise<void> {
  const nonInteractive = !!(overrides.name && overrides.port != null && overrides.authMode && overrides.verification);

  if (!nonInteractive) {
    console.log(BANNER);
    console.log('  Welcome to OpenHive! Let\'s get you set up.\n');
  }

  const prompt = nonInteractive ? null : createPrompt();

  try {
    // Step 1: Determine data directory
    let dataDir: string;

    const globalDefault = path.join(os.homedir(), '.openhive');

    if (explicitDataDir) {
      dataDir = path.resolve(explicitDataDir);
      if (!nonInteractive) console.log(`  Data directory: ${dataDir}\n`);
    } else if (nonInteractive) {
      dataDir = path.resolve(globalDefault);
    } else {
      dataDir = await prompt!.ask('  Data directory', globalDefault);
      dataDir = path.resolve(dataDir);
      console.log('');
    }

    // Step 2: Instance details
    const instanceName = overrides.name ?? await prompt!.ask('  Instance name', 'OpenHive');
    const portNum = overrides.port ?? (parseInt(await prompt!.ask('  Port', '3000'), 10) || 3000);

    // Step 3: Registration mode
    let verificationStrategy: string;
    if (overrides.verification) {
      verificationStrategy = overrides.verification;
    } else {
      const verificationIndex = await prompt!.choose(
        '  Registration mode:',
        [
          'Open - anyone can register (default)',
          'Invite - require an invite code',
          'Manual - admin approves each registration',
        ],
        0,
      );
      verificationStrategy = ['open', 'invite', 'manual'][verificationIndex];
    }

    // Step 4: Auth mode
    let authMode: string;
    if (overrides.authMode) {
      authMode = overrides.authMode;
    } else {
      const authIndex = await prompt!.choose(
        '  Auth mode:',
        [
          'Local - no login required, single-user (default)',
          'Token - email/password registration and API keys',
        ],
        0,
      );
      authMode = ['local', 'token'][authIndex];
    }

    // Step 5: Generate admin key
    const adminKey = nanoid(32);

    // Step 6: Confirm
    const paths = dataDirPaths(dataDir);
    console.log('\n  Summary:');
    console.log(`    Data directory:    ${dataDir}`);
    console.log(`    Database:          ${paths.database}`);
    console.log(`    Uploads:           ${paths.uploads}`);
    console.log(`    Config:            ${paths.config}`);
    console.log(`    Instance name:     ${instanceName}`);
    console.log(`    Port:              ${portNum}`);
    console.log(`    Auth mode:         ${authMode}`);
    console.log(`    Registration:      ${verificationStrategy}`);
    console.log(`    Admin key:         ${adminKey}`);
    console.log('');

    if (!nonInteractive) {
      const confirmed = await prompt!.confirm('  Proceed with setup?', true);
      if (!confirmed) {
        console.log('\n  Setup cancelled.\n');
        prompt!.close();
        return;
      }
    }

    // Step 7: Create everything
    console.log('\n  Setting up...');
    ensureDataDir(dataDir);
    console.log(`    Created ${dataDir}`);

    // Write config file
    const configContent = `// OpenHive Configuration
// Generated by openhive init
// Docs: https://github.com/alexngai/openhive

module.exports = {
  port: ${portNum},
  host: '0.0.0.0',
  database: '${paths.database}',

  instance: {
    name: '${instanceName.replace(/'/g, "\\'")}',
    description: 'A community for AI agents',
    public: true,
  },

  admin: {
    key: process.env.OPENHIVE_ADMIN_KEY || '${adminKey}',
  },

  auth: {
    mode: '${authMode}',
  },

  verification: {
    strategy: '${verificationStrategy}',
  },

  rateLimit: {
    enabled: true,
    max: 100,
    timeWindow: '1 minute',
  },

  storage: {
    type: 'local',
    path: '${paths.uploads}',
    publicUrl: '/uploads',
  },

  federation: {
    enabled: false,
    peers: [],
  },
};
`;
    fs.writeFileSync(paths.config, configContent);
    console.log(`    Created ${paths.config}`);

    // Initialize the database so it's ready immediately
    initDatabase(paths.database);
    closeDatabase();
    console.log(`    Initialised database at ${paths.database}`);

    console.log(`
  Setup complete!

  Start the server:

    openhive serve --data-dir ${dataDir}

  Or set the environment variable:

    export OPENHIVE_HOME="${dataDir}"
    openhive serve

  Your admin key: ${adminKey}
  Save it somewhere safe -- you'll need it for the admin panel.
`);

    // Ask if they want to start now
    if (nonInteractive) {
      prompt?.close();
    } else {
      const startNow = await prompt!.confirm('  Start the server now?', true);
      prompt!.close();

      if (startNow) {
        await startServer({ dataDir, port: portNum });
      }
    }
  } catch (error) {
    prompt?.close();
    throw error;
  }
}

// ============================================================================
// Server start helper
// ============================================================================

interface StartOptions {
  dataDir?: string;
  port?: number;
  host?: string;
  configPath?: string;
  adminKey?: string;
}

function openInBrowser(url: string): void {
  const { exec } = require('child_process');
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  exec(`${cmd} ${url}`);
}

async function startServer(opts: StartOptions): Promise<string> {
  const dataDir = resolveDataDir(opts.dataDir);
  const paths = dataDirPaths(dataDir);

  // Set env vars from resolved data dir (config.ts reads these)
  if (!process.env.OPENHIVE_DATABASE) {
    process.env.OPENHIVE_DATABASE = paths.database;
  }
  if (opts.port) process.env.OPENHIVE_PORT = String(opts.port);
  if (opts.host) process.env.OPENHIVE_HOST = opts.host;
  if (opts.adminKey) process.env.OPENHIVE_ADMIN_KEY = opts.adminKey;

  // Find config file: explicit > CWD > data dir
  const configPath = opts.configPath || findConfigFile(dataDir);

  console.log(BANNER);

  try {
    const server = await createHive(configPath);
    const address = await server.start();

    console.log(`  Data directory: ${dataDir}`);
    console.log(`  Database:       ${paths.database}`);
    console.log('');
    console.log(`  Server:    ${address}`);
    console.log(`  API docs:  ${address}/skill.md`);
    console.log(`  Admin:     ${address}/admin`);
    console.log(`  WebSocket: ws://${address.replace('http://', '')}/ws`);
    console.log(`\n  Press Ctrl+C to stop\n`);

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('\n\n  Shutting down...');

      // Force exit after 10s if graceful shutdown hangs
      const forceExit = setTimeout(() => {
        console.warn('  Shutdown timed out, forcing exit');
        process.exit(1);
      }, 10_000);
      forceExit.unref();

      await server.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    return address;
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// ============================================================================
// Resolve database path helper (for subcommands that need it)
// ============================================================================

function resolveDbPath(explicitDb?: string, explicitDataDir?: string): string {
  if (explicitDb) return path.resolve(explicitDb);
  const dataDir = resolveDataDir(explicitDataDir);
  return dataDirPaths(dataDir).database;
}

// ============================================================================
// CLI program
// ============================================================================

const program = new Command();

program
  .name('openhive')
  .description('OpenHive - A self-hostable social network for AI agents')
  .version('0.1.0')
  .option('--data-dir <path>', 'Data directory (default: ~/.openhive or ./.openhive)')
  .action(async (_options, cmd) => {
    // Default command: run wizard if not initialised, otherwise show help
    const dataDir = resolveDataDir(cmd.opts().dataDir);

    if (isInitialised(dataDir)) {
      // Already set up -- show status
      console.log(BANNER);
      console.log(`  Data directory: ${dataDir}`);
      const paths = dataDirPaths(dataDir);

      if (fs.existsSync(paths.database)) {
        try {
          initDatabase(paths.database);
          const database = getDatabase();
          const agents = database.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number };
          const hives = database.prepare('SELECT COUNT(*) as count FROM hives').get() as { count: number };
          const posts = database.prepare('SELECT COUNT(*) as count FROM posts').get() as { count: number };
          console.log(`  Database:       ${paths.database}`);
          console.log(`  Agents: ${agents.count}  Hives: ${hives.count}  Posts: ${posts.count}`);
          closeDatabase();
        } catch {
          console.log(`  Database:       ${paths.database}`);
        }
      }

      console.log(`\n  Commands:`);
      console.log(`    openhive serve       Start the server`);
      console.log(`    openhive init        Re-run setup wizard`);
      console.log(`    openhive admin       Admin utilities`);
      console.log(`    openhive db          Database utilities`);
      console.log(`    openhive --help      Show all commands`);
      console.log('');
    } else {
      // First run -- launch wizard
      await runSetupWizard(cmd.opts().dataDir);
    }
  });

// Serve command
program
  .command('serve')
  .description('Start the OpenHive server')
  .option('-p, --port <port>', 'Port to listen on')
  .option('-H, --host <host>', 'Host to bind to')
  .option('-d, --database <path>', 'Database file path (overrides data-dir)')
  .option('-c, --config <path>', 'Config file path')
  .option('--admin-key <key>', 'Admin API key')
  .option('--open', 'Open in default browser after starting')
  .action(async (options) => {
    const globalOpts = program.opts();
    const dataDir = resolveDataDir(globalOpts.dataDir);

    // If not initialised and no explicit config/database, prompt to run setup first
    if (!isInitialised(dataDir) && !options.config && !options.database) {
      console.log(BANNER);
      console.log('  No OpenHive instance found. Running setup wizard...\n');
      await runSetupWizard(globalOpts.dataDir);
      return;
    }

    // Override database path if explicitly given
    if (options.database) {
      process.env.OPENHIVE_DATABASE = path.resolve(options.database);
    }

    const address = await startServer({
      dataDir: globalOpts.dataDir,
      port: options.port ? parseInt(options.port, 10) : undefined,
      host: options.host,
      configPath: options.config,
      adminKey: options.adminKey,
    });

    if (options.open) {
      openInBrowser(address);
    }
  });

// Init command (re-run wizard or generate config)
program
  .command('init')
  .description('Run the setup wizard or generate a configuration file')
  .option('--config-only', 'Only generate a config file (no wizard)')
  .option('-o, --output <path>', 'Config file output path')
  .option('--name <name>', 'Instance name (non-interactive)')
  .option('--port <port>', 'Port number (non-interactive)')
  .option('--auth-mode <mode>', 'Auth mode: local or token (non-interactive)')
  .option('--verification <strategy>', 'Registration: open, invite, or manual (non-interactive)')
  .action(async (options) => {
    const globalOpts = program.opts();

    if (options.configOnly) {
      // Legacy behaviour: just write a sample config
      const outputPath = path.resolve(options.output || 'openhive.config.js');
      if (fs.existsSync(outputPath)) {
        console.error(`Error: ${outputPath} already exists`);
        process.exit(1);
      }
      fs.writeFileSync(outputPath, generateSampleConfig());
      console.log(`Created configuration file: ${outputPath}`);
      return;
    }

    await runSetupWizard(globalOpts.dataDir, {
      name: options.name,
      port: options.port ? parseInt(options.port, 10) : undefined,
      authMode: options.authMode,
      verification: options.verification,
    });
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
  .option('-d, --database <path>', 'Database file path')
  .option('-u, --uses <number>', 'Number of uses', '1')
  .action((options) => {
    const dbPath = resolveDbPath(options.database, program.opts().dataDir);
    initDatabase(dbPath);

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
  .option('-d, --database <path>', 'Database file path')
  .requiredOption('-n, --name <name>', 'Agent name')
  .option('--admin', 'Make this agent an admin')
  .option('--description <desc>', 'Agent description')
  .action(async (options) => {
    const dbPath = resolveDbPath(options.database, program.opts().dataDir);
    initDatabase(dbPath);

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
const dbCmd = program.command('db').description('Database utilities');

dbCmd
  .command('migrate')
  .description('Run database migrations')
  .option('-d, --database <path>', 'Database file path')
  .action((options) => {
    const dbPath = resolveDbPath(options.database, program.opts().dataDir);
    console.log('Running migrations...');
    initDatabase(dbPath);
    console.log('Migrations complete.');
    closeDatabase();
  });

dbCmd
  .command('stats')
  .description('Show database statistics')
  .option('-d, --database <path>', 'Database file path')
  .action((options) => {
    const dbPath = resolveDbPath(options.database, program.opts().dataDir);
    initDatabase(dbPath);
    const database = getDatabase();

    const agents = database.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number };
    const hives = database.prepare('SELECT COUNT(*) as count FROM hives').get() as { count: number };
    const posts = database.prepare('SELECT COUNT(*) as count FROM posts').get() as { count: number };
    const comments = database.prepare('SELECT COUNT(*) as count FROM comments').get() as { count: number };

    console.log(`\nDatabase: ${dbPath}`);
    console.log(`Agents: ${agents.count}`);
    console.log(`Hives: ${hives.count}`);
    console.log(`Posts: ${posts.count}`);
    console.log(`Comments: ${comments.count}`);

    closeDatabase();
  });

dbCmd
  .command('seed')
  .description('Seed database with sample data')
  .option('-d, --database <path>', 'Database file path')
  .action(async (options) => {
    const dbPath = resolveDbPath(options.database, program.opts().dataDir);
    initDatabase(dbPath);

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

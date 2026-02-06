import { describe, it, expect, afterAll } from 'vitest';
import { execSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CLI_PATH = path.resolve(__dirname, '../../dist/cli.js');
const BIN_PATH = path.resolve(__dirname, '../../bin/openhive.js');
const TEST_ROOT = path.join(os.tmpdir(), `openhive-test-cli-${process.pid}`);

function cleanDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function mkTemp(name: string): string {
  const dir = path.join(TEST_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runCli(args: string, env?: Record<string, string>): string {
  return execSync(`node ${CLI_PATH} ${args}`, {
    encoding: 'utf-8',
    timeout: 15000,
    env: { ...process.env, ...env },
  }).trim();
}

// Ensure compiled CLI exists before running tests
function ensureBuild(): void {
  if (!fs.existsSync(CLI_PATH)) {
    throw new Error(
      `CLI not built. Run "npm run build:server" before running CLI tests.\n` +
      `Expected: ${CLI_PATH}`
    );
  }
}

describe('CLI', () => {
  beforeAll(() => {
    ensureBuild();
  });

  afterAll(() => {
    cleanDir(TEST_ROOT);
  });

  // ===========================================================================
  // Basic CLI commands
  // ===========================================================================

  describe('basic commands', () => {
    it('should show version with --version', () => {
      const output = runCli('--version');
      expect(output).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should show help with --help', () => {
      const output = runCli('--help');
      expect(output).toContain('OpenHive');
      expect(output).toContain('serve');
      expect(output).toContain('init');
      expect(output).toContain('admin');
      expect(output).toContain('db');
      expect(output).toContain('--data-dir');
    });

    it('should show serve help', () => {
      const output = runCli('serve --help');
      expect(output).toContain('--port');
      expect(output).toContain('--host');
      expect(output).toContain('--database');
      expect(output).toContain('--config');
      expect(output).toContain('--admin-key');
      expect(output).toContain('--open');
    });

    it('should show init help', () => {
      const output = runCli('init --help');
      expect(output).toContain('--config-only');
      expect(output).toContain('--output');
    });

    it('should show admin help', () => {
      const output = runCli('admin --help');
      expect(output).toContain('create-key');
      expect(output).toContain('create-invite');
      expect(output).toContain('create-agent');
    });

    it('should show db help', () => {
      const output = runCli('db --help');
      expect(output).toContain('migrate');
      expect(output).toContain('stats');
      expect(output).toContain('seed');
    });

    it('should show network help', () => {
      const output = runCli('network --help');
      expect(output).toContain('setup');
      expect(output).toContain('status');
      expect(output).toContain('check');
    });
  });

  // ===========================================================================
  // bin entry point
  // ===========================================================================

  describe('bin entry point', () => {
    it('should work via bin/openhive.js', () => {
      const output = execSync(`node ${BIN_PATH} --version`, {
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();
      expect(output).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should show help via bin/openhive.js', () => {
      const output = execSync(`node ${BIN_PATH} --help`, {
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();
      expect(output).toContain('OpenHive');
      expect(output).toContain('serve');
    });
  });

  // ===========================================================================
  // admin create-key
  // ===========================================================================

  describe('admin create-key', () => {
    it('should generate an admin key', () => {
      const output = runCli('admin create-key');
      expect(output).toContain('Generated admin key:');
      expect(output).toContain('OPENHIVE_ADMIN_KEY');
    });

    it('should generate unique keys on each call', () => {
      const output1 = runCli('admin create-key');
      const output2 = runCli('admin create-key');

      const key1 = output1.match(/Generated admin key: (.+)/)?.[1];
      const key2 = output2.match(/Generated admin key: (.+)/)?.[1];

      expect(key1).toBeDefined();
      expect(key2).toBeDefined();
      expect(key1).not.toBe(key2);
    });
  });

  // ===========================================================================
  // init --config-only
  // ===========================================================================

  describe('init --config-only', () => {
    it('should generate a config file', () => {
      const dir = mkTemp('init-config-only');
      const outputPath = path.join(dir, 'openhive.config.js');

      const output = runCli(`init --config-only -o ${outputPath}`);
      expect(output).toContain('Created configuration file');
      expect(fs.existsSync(outputPath)).toBe(true);

      const content = fs.readFileSync(outputPath, 'utf-8');
      expect(content).toContain('module.exports');
      expect(content).toContain('port');
      expect(content).toContain('database');
      expect(content).toContain('verification');
    });

    it('should refuse to overwrite an existing file', () => {
      const dir = mkTemp('init-no-overwrite');
      const outputPath = path.join(dir, 'openhive.config.js');
      fs.writeFileSync(outputPath, 'existing content');

      expect(() => {
        runCli(`init --config-only -o ${outputPath}`);
      }).toThrow();
    });
  });

  // ===========================================================================
  // Default command (no args) with --data-dir
  // ===========================================================================

  describe('default command', () => {
    it('should show status when data dir is initialised', () => {
      const dir = mkTemp('default-status');

      // Create marker and data dir
      fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.openhive-root'), 'test');

      const output = runCli(`--data-dir ${dir}`);
      expect(output).toContain('Data directory:');
      expect(output).toContain(dir);
      expect(output).toContain('openhive serve');
    });
  });

  // ===========================================================================
  // db commands with --data-dir
  // ===========================================================================

  describe('db commands with --data-dir', () => {
    const dataDir = path.join(TEST_ROOT, 'db-commands');

    beforeAll(() => {
      cleanDir(dataDir);
      fs.mkdirSync(path.join(dataDir, 'data'), { recursive: true });
      fs.writeFileSync(path.join(dataDir, '.openhive-root'), 'test');
    });

    it('should run migrations using data-dir database', () => {
      const output = runCli(`--data-dir ${dataDir} db migrate`);
      expect(output).toContain('Running migrations');
      expect(output).toContain('Migrations complete');

      // Database should now exist
      const dbPath = path.join(dataDir, 'data', 'openhive.db');
      expect(fs.existsSync(dbPath)).toBe(true);
    });

    it('should show stats using data-dir database', () => {
      const output = runCli(`--data-dir ${dataDir} db stats`);
      expect(output).toContain('Agents:');
      expect(output).toContain('Hives:');
      expect(output).toContain('Posts:');
      expect(output).toContain('Comments:');
    });

    it('should seed data using data-dir database', () => {
      const output = runCli(`--data-dir ${dataDir} db seed`);
      expect(output).toContain('Seeding database');
      expect(output).toContain('Created agent: demo-agent');
      expect(output).toContain('Created invite code');
      expect(output).toContain('Seed complete');
    });

    it('should show updated stats after seeding', () => {
      const output = runCli(`--data-dir ${dataDir} db stats`);
      // After seeding, there should be at least 1 agent
      expect(output).toMatch(/Agents: [1-9]\d*/);
    });
  });

  // ===========================================================================
  // admin commands with --data-dir
  // ===========================================================================

  describe('admin commands with --data-dir', () => {
    const dataDir = path.join(TEST_ROOT, 'admin-commands');

    beforeAll(() => {
      cleanDir(dataDir);
      fs.mkdirSync(path.join(dataDir, 'data'), { recursive: true });
      fs.writeFileSync(path.join(dataDir, '.openhive-root'), 'test');

      // Initialise the database
      runCli(`--data-dir ${dataDir} db migrate`);
    });

    it('should create an invite code', () => {
      const output = runCli(`--data-dir ${dataDir} admin create-invite`);
      expect(output).toContain('Created invite code:');
      expect(output).toContain('Uses remaining: 1');
    });

    it('should create an invite code with custom uses', () => {
      const output = runCli(`--data-dir ${dataDir} admin create-invite -u 10`);
      expect(output).toContain('Uses remaining: 10');
    });

    it('should create an agent', () => {
      const output = runCli(`--data-dir ${dataDir} admin create-agent -n test-cli-agent`);
      expect(output).toContain('Created agent: test-cli-agent');
      expect(output).toContain('Agent ID:');
      expect(output).toContain('API Key:');
    });

    it('should create an admin agent', () => {
      const output = runCli(`--data-dir ${dataDir} admin create-agent -n admin-agent --admin`);
      expect(output).toContain('Created agent: admin-agent');
      expect(output).toContain('Admin: Yes');
    });
  });

  // ===========================================================================
  // Database path override (-d flag)
  // ===========================================================================

  describe('database path override', () => {
    it('should use explicit -d database path for db stats', () => {
      const dir = mkTemp('db-override');
      const dbPath = path.join(dir, 'custom.db');

      // First create the database via migrate
      runCli(`db migrate -d ${dbPath}`);
      expect(fs.existsSync(dbPath)).toBe(true);

      // Then check stats
      const output = runCli(`db stats -d ${dbPath}`);
      expect(output).toContain(dbPath);
      expect(output).toContain('Agents:');
    });
  });

  // ===========================================================================
  // OPENHIVE_HOME env var
  // ===========================================================================

  describe('OPENHIVE_HOME environment variable', () => {
    it('should use OPENHIVE_HOME for database resolution', () => {
      const dir = mkTemp('env-home-db');
      fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.openhive-root'), 'test');

      runCli('db migrate', { OPENHIVE_HOME: dir });

      const dbPath = path.join(dir, 'data', 'openhive.db');
      expect(fs.existsSync(dbPath)).toBe(true);
    });

    it('--data-dir should take priority over OPENHIVE_HOME', () => {
      const envDir = mkTemp('env-home-priority-env');
      const flagDir = mkTemp('env-home-priority-flag');
      fs.mkdirSync(path.join(envDir, 'data'), { recursive: true });
      fs.mkdirSync(path.join(flagDir, 'data'), { recursive: true });
      fs.writeFileSync(path.join(envDir, '.openhive-root'), 'test');
      fs.writeFileSync(path.join(flagDir, '.openhive-root'), 'test');

      runCli(`--data-dir ${flagDir} db migrate`, { OPENHIVE_HOME: envDir });

      // Database should be in flagDir, not envDir
      expect(fs.existsSync(path.join(flagDir, 'data', 'openhive.db'))).toBe(true);
    });
  });
});

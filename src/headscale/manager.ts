/**
 * Headscale Process Manager
 *
 * Manages the headscale binary as a sidecar process:
 * - Generates config and writes it to disk
 * - Starts headscale as a child process
 * - Waits for health check
 * - Bootstraps an API key for programmatic access
 * - Stops the process on shutdown
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { HeadscaleClient } from './client.js';
import {
  generateHeadscaleConfig,
  writeHeadscaleConfig,
  type HeadscaleSidecarOptions,
} from './config.js';

export interface HeadscaleManagerOptions extends HeadscaleSidecarOptions {
  /** Path to the headscale binary. Defaults to 'headscale' (must be in PATH) */
  binaryPath?: string;
  /** Timeout in ms for headscale to become healthy. Default: 30000 */
  healthTimeoutMs?: number;
}

export interface HeadscaleManagerState {
  running: boolean;
  pid: number | null;
  apiKey: string | null;
  client: HeadscaleClient | null;
  listenAddr: string;
}

export class HeadscaleManager {
  private opts: HeadscaleManagerOptions;
  private process: ChildProcess | null = null;
  private apiKey: string | null = null;
  private client: HeadscaleClient | null = null;
  private configPath: string;
  private apiKeyPath: string;

  constructor(opts: HeadscaleManagerOptions) {
    this.opts = opts;
    this.configPath = path.join(opts.dataDir, 'config.yaml');
    this.apiKeyPath = path.join(opts.dataDir, '.api_key');
  }

  /**
   * Start headscale as a managed sidecar process.
   * 1. Generate and write config
   * 2. Spawn headscale serve
   * 3. Wait for health
   * 4. Bootstrap or load API key
   * 5. Return the client
   */
  async start(): Promise<HeadscaleClient> {
    // Ensure data directory exists
    const dataDir = path.resolve(this.opts.dataDir);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Generate and write config
    const config = generateHeadscaleConfig(this.opts);
    writeHeadscaleConfig(config, this.configPath);

    // Check if we already have an API key from a previous run
    if (fs.existsSync(this.apiKeyPath)) {
      this.apiKey = fs.readFileSync(this.apiKeyPath, 'utf-8').trim();
    }

    // Spawn headscale process
    const binaryPath = this.opts.binaryPath || 'headscale';
    const listenAddr = this.opts.listenAddr || '127.0.0.1:8085';

    this.process = spawn(binaryPath, ['serve', '-c', this.configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Override in case env vars conflict
        HEADSCALE_CONFIG: this.configPath,
      },
    });

    // Log headscale output
    this.process.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`[headscale] ${line}`);
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.error(`[headscale] ${line}`);
    });

    this.process.on('exit', (code, signal) => {
      console.log(`[headscale] Process exited (code=${code}, signal=${signal})`);
      this.process = null;
    });

    this.process.on('error', (err) => {
      console.error(`[headscale] Failed to start: ${err.message}`);
      this.process = null;
    });

    // Wait a moment for the process to initialize
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Check if process is still running
    if (!this.process || this.process.exitCode !== null) {
      throw new Error(
        `Headscale failed to start. Is the binary at "${binaryPath}" accessible? ` +
        'Install headscale or set headscale.binaryPath in your config.'
      );
    }

    // If we don't have an API key, we need to create one via CLI
    if (!this.apiKey) {
      this.apiKey = await this.bootstrapApiKey(binaryPath);
      // Persist it for future runs
      fs.writeFileSync(this.apiKeyPath, this.apiKey, { mode: 0o600 });
    }

    // Create client and wait for healthy
    const baseUrl = `http://${listenAddr}`;
    this.client = new HeadscaleClient(baseUrl, this.apiKey);

    const timeoutMs = this.opts.healthTimeoutMs || 30000;
    await this.client.waitForHealthy(timeoutMs);

    console.log(`[headscale] Sidecar healthy at ${baseUrl}`);
    return this.client;
  }

  /**
   * Stop the headscale sidecar process.
   */
  async stop(): Promise<void> {
    if (this.process) {
      console.log('[headscale] Stopping sidecar...');
      this.process.kill('SIGTERM');

      // Wait for graceful shutdown (max 5s)
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            this.process.kill('SIGKILL');
          }
          resolve();
        }, 5000);

        if (this.process) {
          this.process.on('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });

      this.process = null;
      this.client = null;
      console.log('[headscale] Sidecar stopped.');
    }
  }

  /**
   * Get the headscale API client. Throws if not started.
   */
  getClient(): HeadscaleClient {
    if (!this.client) {
      throw new Error('Headscale manager not started. Call start() first.');
    }
    return this.client;
  }

  /**
   * Get the current state of the manager.
   */
  getState(): HeadscaleManagerState {
    return {
      running: this.process !== null && this.process.exitCode === null,
      pid: this.process?.pid || null,
      apiKey: this.apiKey ? `${this.apiKey.substring(0, 10)}...` : null,
      client: this.client,
      listenAddr: this.opts.listenAddr || '127.0.0.1:8085',
    };
  }

  /**
   * Bootstrap the initial API key using headscale CLI.
   * On first run, there's no API key yet, so we use the CLI (which uses the unix socket).
   */
  private async bootstrapApiKey(binaryPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(binaryPath, [
        'apikeys', 'create',
        '--expiration', '87600h', // 10 years
        '-c', this.configPath,
        '--output', 'json',
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HEADSCALE_CONFIG: this.configPath },
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

      child.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Failed to create headscale API key (exit ${code}): ${stderr}`));
          return;
        }

        try {
          // Output might be JSON or plain text depending on version
          const trimmed = stdout.trim();
          // Try JSON parse first
          try {
            const parsed = JSON.parse(trimmed);
            resolve(parsed.apiKey || parsed.key || trimmed);
          } catch {
            // Plain text output - the key itself
            resolve(trimmed);
          }
        } catch (err) {
          reject(new Error(`Failed to parse API key output: ${stdout}`));
        }
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to run headscale CLI: ${err.message}`));
      });
    });
  }
}

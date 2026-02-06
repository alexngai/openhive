/**
 * CLI: openhive network
 *
 * Interactive setup wizard and status commands for mesh networking.
 *
 * Commands:
 *   openhive network setup   - Interactive setup wizard
 *   openhive network status  - Check current network provider status
 *   openhive network check   - Verify connectivity and prerequisites
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { createNetworkProvider, type NetworkProvider } from '../network/index.js';
import type { NetworkConfig } from '../network/factory.js';

// ============================================================================
// Helpers
// ============================================================================

function createPrompt(): { ask(question: string): Promise<string>; choose(question: string, options: string[]): Promise<number>; close(): void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return {
    ask(question: string): Promise<string> {
      return new Promise((resolve) => {
        rl.question(question, (answer) => resolve(answer.trim()));
      });
    },

    async choose(question: string, options: string[]): Promise<number> {
      console.log(`\n${question}`);
      options.forEach((opt, i) => {
        console.log(`  ${i + 1}) ${opt}`);
      });

      while (true) {
        const answer = await this.ask(`\nChoice [1-${options.length}]: `);
        const num = parseInt(answer, 10);
        if (num >= 1 && num <= options.length) return num - 1;
        console.log(`  Please enter a number between 1 and ${options.length}.`);
      }
    },

    close() {
      rl.close();
    },
  };
}

async function detectEnvironment(): Promise<{
  publicIp: string | null;
  localIp: string | null;
  isCgnat: boolean;
  headscaleInstalled: boolean;
  headscaleVersion: string | null;
  tailscaleInstalled: boolean;
}> {
  let publicIp: string | null = null;
  let localIp: string | null = null;
  let isCgnat = false;
  let headscaleInstalled = false;
  let headscaleVersion: string | null = null;
  let tailscaleInstalled = false;

  // Detect public IP
  console.log('  Detecting public IP...');
  try {
    const resp = await fetch('https://ifconfig.me/ip', { signal: AbortSignal.timeout(5000) });
    if (resp.ok) publicIp = (await resp.text()).trim();
  } catch {
    // offline or blocked
  }

  // Check for CGNAT
  if (publicIp) {
    const parts = publicIp.split('.').map(Number);
    isCgnat = (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
              (parts[0] === 10) ||
              (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
              (parts[0] === 192 && parts[1] === 168);
  }

  // Get local IP
  try {
    const { networkInterfaces } = await import('os');
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          localIp = net.address;
          break;
        }
      }
      if (localIp) break;
    }
  } catch {
    // ignore
  }

  // Check for headscale binary
  console.log('  Checking for headscale binary...');
  try {
    const { execSync } = await import('child_process');
    const version = execSync('headscale version 2>/dev/null', { encoding: 'utf-8' }).trim();
    headscaleInstalled = true;
    headscaleVersion = version;
  } catch {
    // not installed
  }

  // Check for tailscale binary
  console.log('  Checking for tailscale client...');
  try {
    const { execSync } = await import('child_process');
    execSync('tailscale version 2>/dev/null', { encoding: 'utf-8' });
    tailscaleInstalled = true;
  } catch {
    // not installed
  }

  return { publicIp, localIp, isCgnat, headscaleInstalled, headscaleVersion, tailscaleInstalled };
}

// ============================================================================
// Setup wizard
// ============================================================================

async function runSetup(): Promise<void> {
  console.log(`
  OpenHive Network Setup
  ----------------------

  This wizard configures mesh networking so MAP swarm hosts
  can reach each other, even behind NATs.
`);

  const prompt = createPrompt();

  // Step 1: Detect environment
  console.log('Checking prerequisites...');
  const env = await detectEnvironment();
  console.log('');

  if (env.publicIp) {
    console.log(`  Public IP: ${env.publicIp}${env.isCgnat ? ' (CGNAT detected!)' : ''}`);
  } else {
    console.log('  Public IP: could not detect (offline?)');
  }
  if (env.localIp) console.log(`  Local IP: ${env.localIp}`);
  console.log(`  headscale: ${env.headscaleInstalled ? `installed (${env.headscaleVersion})` : 'not found'}`);
  console.log(`  tailscale: ${env.tailscaleInstalled ? 'installed' : 'not found (needed on swarm hosts, not this server)'}`);

  // Step 2: Choose provider
  const providerOptions = [
    'Tailscale Cloud (SaaS, simplest — no infrastructure to manage)',
    'Headscale sidecar (self-hosted, OpenHive manages the process)',
    'External headscale (connect to an existing headscale instance)',
    'Skip (L7 discovery only, no mesh networking)',
  ];

  if (env.isCgnat) {
    console.log('\n  WARNING: CGNAT detected. Your ISP does not give you a public IP.');
    console.log('  Tailscale Cloud is recommended, or use a VPS relay with headscale.');
  }

  const providerChoice = await prompt.choose('Which network provider do you want to use?', providerOptions);

  let networkConfig: Record<string, unknown> = {};

  switch (providerChoice) {
    case 0: // Tailscale Cloud
      networkConfig = await setupTailscale(prompt);
      break;
    case 1: // Headscale sidecar
      networkConfig = await setupHeadscaleSidecar(prompt, env);
      break;
    case 2: // External headscale
      networkConfig = await setupHeadscaleExternal(prompt);
      break;
    case 3: // Skip
      console.log('\n  Skipping network setup. You can configure it later in your config file.');
      prompt.close();
      return;
  }

  // Step 3: Write config
  const configPath = path.resolve('openhive.config.json');
  let existingConfig: Record<string, unknown> = {};

  if (fs.existsSync(configPath)) {
    try {
      existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      // ignore parse errors
    }
  }

  existingConfig.network = networkConfig;
  fs.writeFileSync(configPath, JSON.stringify(existingConfig, null, 2), 'utf-8');
  console.log(`\n  Configuration written to ${configPath}`);

  // Step 4: Verify
  console.log('\n  Verifying...');
  try {
    const provider = createNetworkProvider(networkConfig as unknown as NetworkConfig);
    await provider.start();
    const connectivity = await provider.checkConnectivity();
    await provider.stop();

    if (connectivity.reachable) {
      console.log('  Connectivity check passed!');
    } else {
      console.log(`  Warning: Connectivity check failed: ${connectivity.error || 'unknown'}`);
      console.log('  This may be OK if you haven\'t set up DNS/TLS yet.');
    }
  } catch (err) {
    console.log(`  Warning: Could not verify provider: ${(err as Error).message}`);
    console.log('  Check your configuration and try again.');
  }

  console.log(`
  Done! Your network configuration has been saved.

  Next steps:
    1. Start OpenHive: openhive serve
    2. Register a swarm: POST /api/v1/map/swarms
    3. Join a hive: POST /api/v1/map/swarms/{id}/hives
    4. Get a mesh key: POST /api/v1/map/swarms/{id}/network
    5. On each swarm host: tailscale up --authkey <key>
`);

  prompt.close();
}

async function setupTailscale(prompt: ReturnType<typeof createPrompt>): Promise<Record<string, unknown>> {
  console.log(`
  Tailscale Cloud Setup
  ---------------------
  You'll need a Tailscale account and an API key or OAuth client.
  Get your API key at: https://login.tailscale.com/admin/settings/keys
`);

  const tailnet = await prompt.ask('  Tailnet name (e.g., your-org.ts.net, or "-" for default): ');

  const authChoice = await prompt.choose('Authentication method:', [
    'API key (simpler, expires in 90 days)',
    'OAuth client (recommended for automation, auto-refreshes)',
  ]);

  if (authChoice === 0) {
    const apiKey = await prompt.ask('  API key (tskey-api-...): ');
    return {
      provider: 'tailscale-cloud',
      tailscale: { tailnet: tailnet || '-', apiKey },
    };
  } else {
    const clientId = await prompt.ask('  OAuth client ID: ');
    const clientSecret = await prompt.ask('  OAuth client secret: ');
    return {
      provider: 'tailscale-cloud',
      tailscale: { tailnet: tailnet || '-', oauthClientId: clientId, oauthClientSecret: clientSecret },
    };
  }
}

async function setupHeadscaleSidecar(
  prompt: ReturnType<typeof createPrompt>,
  env: Awaited<ReturnType<typeof detectEnvironment>>,
): Promise<Record<string, unknown>> {
  console.log(`
  Headscale Sidecar Setup
  -----------------------
  OpenHive will manage a headscale process. Tailscale clients connect
  to this server for key exchange and coordination.
`);

  if (!env.headscaleInstalled) {
    console.log('  WARNING: headscale binary not found in PATH.');
    console.log('  Install it from: https://github.com/juanfont/headscale/releases');
    console.log('  Or set headscaleSidecar.binaryPath to the full path.\n');
  }

  if (env.isCgnat) {
    console.log('  WARNING: CGNAT detected. You will need a VPS as a relay.');
    console.log('  See docs/HEADSCALE_HOSTING_SPEC.md for Scenario C.\n');
  }

  const serverUrl = await prompt.ask('  Server URL (HTTPS, reachable by swarm hosts, e.g., https://openhive.example.com): ');

  if (serverUrl && !serverUrl.startsWith('https://')) {
    console.log('  WARNING: Tailscale clients require HTTPS. Plain HTTP will not work.');
  }

  const baseDomain = await prompt.ask('  MagicDNS base domain [hive.internal]: ') || 'hive.internal';

  const tlsChoice = await prompt.choose('TLS certificate:', [
    'Let\'s Encrypt (automatic, recommended)',
    'I have my own certificate',
    'My reverse proxy handles TLS (e.g., Caddy, nginx)',
    'None (development only)',
  ]);

  const tls: Record<string, unknown> = { mode: 'none' };
  if (tlsChoice === 0) {
    const hostname = serverUrl ? new URL(serverUrl).hostname : await prompt.ask('  Hostname for Let\'s Encrypt: ');
    tls.mode = 'letsencrypt';
    tls.letsencryptHostname = hostname;
  } else if (tlsChoice === 1) {
    tls.mode = 'manual';
    tls.certPath = await prompt.ask('  Path to certificate (fullchain.pem): ');
    tls.keyPath = await prompt.ask('  Path to private key (privkey.pem): ');
  } else if (tlsChoice === 2) {
    tls.mode = 'reverse-proxy';
  }

  const derpChoice = await prompt.choose('Embedded DERP relay (helps with NAT traversal):', [
    'Yes (recommended)',
    'No (use Tailscale\'s public DERP relays)',
  ]);

  const config: Record<string, unknown> = {
    provider: 'headscale-sidecar',
    headscaleSidecar: {
      serverUrl: serverUrl || 'https://openhive.example.com',
      baseDomain,
      embeddedDerp: derpChoice === 0,
      tls,
    },
  };

  return config;
}

async function setupHeadscaleExternal(prompt: ReturnType<typeof createPrompt>): Promise<Record<string, unknown>> {
  console.log(`
  External Headscale Setup
  ------------------------
  Connect to an existing headscale instance via its REST API.
  You'll need the API URL and an API key.
`);

  const apiUrl = await prompt.ask('  Headscale API URL (e.g., http://localhost:8085): ');
  const apiKey = await prompt.ask('  API key: ');
  const serverUrl = await prompt.ask('  Server URL for tailscale clients (if different from API URL) [same]: ') || undefined;
  const baseDomain = await prompt.ask('  MagicDNS base domain [hive.internal]: ') || 'hive.internal';

  return {
    provider: 'headscale-external',
    headscaleExternal: {
      apiUrl: apiUrl || 'http://localhost:8085',
      apiKey,
      serverUrl,
      baseDomain,
    },
  };
}

// ============================================================================
// Status command
// ============================================================================

async function runStatus(configPath: string | undefined): Promise<void> {
  console.log('\nNetwork Provider Status\n');

  // Try to load config
  let networkConfig: NetworkConfig = { provider: 'none' };

  const configFiles = [
    configPath,
    'openhive.config.json',
    'openhive.config.js',
  ].filter(Boolean) as string[];

  for (const file of configFiles) {
    if (fs.existsSync(file)) {
      try {
        const raw = file.endsWith('.json')
          ? JSON.parse(fs.readFileSync(file, 'utf-8'))
          : require(path.resolve(file));
        const config = raw.default || raw;
        if (config.network) {
          networkConfig = config.network;
          console.log(`  Config: ${file}`);
          break;
        }
      } catch {
        // continue
      }
    }
  }

  console.log(`  Provider: ${networkConfig.provider}`);

  if (networkConfig.provider === 'none') {
    console.log('  No network provider configured.');
    console.log('  Run "openhive network setup" to configure one.');
    return;
  }

  try {
    const provider = createNetworkProvider(networkConfig);
    await provider.start();

    console.log(`  Ready: ${provider.isReady()}`);
    console.log(`  Server URL: ${provider.getServerUrl()}`);

    const connectivity = await provider.checkConnectivity();
    console.log(`  Reachable: ${connectivity.reachable}`);
    if (connectivity.publicIp) console.log(`  Public IP: ${connectivity.publicIp}`);
    if (connectivity.isCgnat) console.log(`  CGNAT: detected`);
    if (connectivity.error) console.log(`  Error: ${connectivity.error}`);

    const devices = await provider.listDevices();
    console.log(`  Connected devices: ${devices.length}`);
    for (const d of devices) {
      const status = d.online ? 'online' : 'offline';
      console.log(`    - ${d.name} [${status}] ${d.ips.join(', ')} ${d.dnsName || ''}`);
    }

    await provider.stop();
  } catch (err) {
    console.log(`  Error: ${(err as Error).message}`);
  }

  console.log('');
}

// ============================================================================
// Command registration
// ============================================================================

export function registerNetworkCommands(program: Command): void {
  const network = program.command('network').description('Mesh networking setup and management');

  network
    .command('setup')
    .description('Interactive setup wizard for mesh networking')
    .action(async () => {
      await runSetup();
    });

  network
    .command('status')
    .description('Check network provider status and connectivity')
    .option('-c, --config <path>', 'Config file path')
    .action(async (options) => {
      await runStatus(options.config);
    });

  network
    .command('check')
    .description('Verify prerequisites for mesh networking')
    .action(async () => {
      console.log('\nChecking prerequisites...\n');
      const env = await detectEnvironment();

      console.log(`  Public IP: ${env.publicIp || 'not detected'}`);
      console.log(`  Local IP: ${env.localIp || 'not detected'}`);
      console.log(`  CGNAT: ${env.isCgnat ? 'YES (you need a VPS relay or Tailscale Cloud)' : 'no'}`);
      console.log(`  headscale: ${env.headscaleInstalled ? `${env.headscaleVersion}` : 'NOT INSTALLED'}`);
      console.log(`  tailscale: ${env.tailscaleInstalled ? 'installed' : 'not installed (needed on swarm hosts)'}`);

      if (!env.headscaleInstalled) {
        console.log('\n  To install headscale:');
        console.log('    https://github.com/juanfont/headscale/releases');
      }

      if (env.isCgnat) {
        console.log('\n  CGNAT workarounds:');
        console.log('    1. Use Tailscale Cloud (simplest)');
        console.log('    2. Use a cheap VPS ($3-5/mo) as a relay');
        console.log('    See: docs/HEADSCALE_HOSTING_SPEC.md');
      }

      console.log('');
    });
}

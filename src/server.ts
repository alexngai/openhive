import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import * as path from 'path';
import * as fs from 'fs';
import { Config, loadConfig } from './config.js';
import { initDatabase, closeDatabase } from './db/index.js';
import { registerRoutes } from './api/index.js';
import { setupWebSocket, stopHeartbeat } from './realtime/index.js';
import { generateSkillMd } from './skill.js';
import { generateSitemap, generateRobotsTxt } from './services/sitemap.js';
import { initializeStorage, type StorageConfig } from './storage/index.js';
import { initEmail } from './services/email.js';
import { createNetworkProvider, type NetworkProvider } from './network/index.js';
import { syncProtocolRoutes } from './api/routes/sync-protocol.js';
import { initSyncService } from './sync/service.js';
import type { SyncService } from './sync/service.js';
import { SwarmManager } from './swarm/manager.js';
import type { SwarmHostingConfig } from './swarm/types.js';
import { getOrCreateLocalAgent } from './db/dal/agents.js';
import { setLocalAgent } from './api/middleware/auth.js';

export interface HiveServer {
  fastify: FastifyInstance;
  config: Config;
  start(): Promise<string>;
  stop(): Promise<void>;
}

export async function createHive(configInput?: Partial<Config> | string): Promise<HiveServer> {
  // Load configuration
  let config: Config;
  if (typeof configInput === 'string') {
    config = loadConfig(configInput);
  } else if (configInput) {
    config = loadConfig();
    // Merge with provided config
    Object.assign(config, configInput);
  } else {
    config = loadConfig();
  }

  // Initialize database
  initDatabase(config.database);

  // Set up local auth mode if configured
  if (config.auth.mode === 'local') {
    const agent = await getOrCreateLocalAgent();
    setLocalAgent(agent);
    console.log('[openhive] Local auth mode — all requests auto-authenticated as "local"');
  }

  // Initialize storage if configured
  if (config.storage) {
    initializeStorage(config.storage as StorageConfig);
    // Ensure local upload directory exists
    if (config.storage.type === 'local') {
      const uploadPath = path.resolve(config.storage.path);
      if (!fs.existsSync(uploadPath)) {
        fs.mkdirSync(uploadPath, { recursive: true });
      }
    }
  }

  // Initialize email service
  initEmail(config.email);

  // Create Fastify instance
  const fastify = Fastify({
    logger: {
      level: 'info',
    },
  });

  // Register CORS
  if (config.cors.enabled) {
    await fastify.register(cors, {
      origin: config.cors.origin,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key'],
    });
  }

  // Register rate limiting
  if (config.rateLimit.enabled) {
    await fastify.register(rateLimit, {
      max: config.rateLimit.max,
      timeWindow: config.rateLimit.timeWindow,
      keyGenerator: (request) => {
        // Use agent ID if authenticated, otherwise IP
        return (request as { agent?: { id: string } }).agent?.id || request.ip;
      },
    });
  }

  // Register multipart for file uploads
  await fastify.register(multipart, {
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB
      files: 1, // Only one file at a time
    },
  });

  // Register WebSocket
  await fastify.register(websocket);

  // Setup WebSocket handlers
  setupWebSocket(fastify);

  // Register API routes
  await registerRoutes(fastify, config);

  // Register sync protocol routes (peer-to-peer, separate from API)
  await fastify.register(syncProtocolRoutes, { prefix: '/sync/v1' });

  // Initialize sync service
  let syncService: SyncService | null = null;
  if (config.sync.enabled) {
    syncService = initSyncService(config.sync);
  }

  // Initialize SwarmCraft plugin (MAP client for agent monitoring)
  if (config.swarmcraft.enabled) {
    try {
      const { getDatabaseConfig } = await import('./db/index.js');
      const dbConf = getDatabaseConfig();
      const dbPath = (dbConf && dbConf.type === 'sqlite') ? dbConf.path : './data/openhive.db';

      const scPrefix = config.swarmcraft.prefix || '/api/swarmcraft';
      const scWsPath = config.swarmcraft.wsPath || '/ws/swarmcraft';
      const scTerminalWsPath = config.swarmcraft.terminalWsPath || '/ws/swarmcraft/terminal';

      const { swarmcraftPlugin } = await import('swarmcraft/plugin');
      await fastify.register(swarmcraftPlugin, {
        database: { type: 'sqlite', path: dbPath, tablePrefix: 'sc_' },
        prefix: scPrefix,
        wsPath: scWsPath,
        terminalWsPath: scTerminalWsPath,
        logLevel: config.swarmcraft.logLevel || 'info',
        corsOrigin: typeof config.cors.origin === 'string' ? config.cors.origin : undefined,
      });
      console.log(`[openhive] SwarmCraft plugin registered at ${scPrefix}`);

      // Bridge: auto-connect SwarmCraft MAP client when swarms register with the Hub
      const mcm = (fastify as any).swarmcraft.mapClientManager;
      const connectSwarm = async (id: string, name: string, endpoint: string, authMethod?: string) => {
        try {
          await mcm.connect({
            id, name, url: endpoint,
            auth: authMethod === 'none' || !authMethod
              ? { method: 'none' as const }
              : { method: authMethod as 'bearer' | 'api-key', token: undefined },
          });
          console.log(`[openhive] SwarmCraft bridge: connected to ${name}`);
        } catch (err) {
          console.warn(`[openhive] SwarmCraft bridge: failed to connect to ${name}: ${(err as Error).message}`);
        }
      };

      // Connect to existing online swarms at startup
      const { listSwarms } = await import('./db/dal/map.js');
      const { data: online } = listSwarms({ status: 'online', limit: 500 });
      for (const s of online) await connectSwarm(s.id, s.name, s.map_endpoint, s.auth_method);

      // Subscribe to new registrations
      const { mapHubEvents } = await import('./map/service.js');
      mapHubEvents.on('swarm_registered', (e: { swarm_id: string; name: string; map_endpoint: string; auth_method?: string }) => {
        connectSwarm(e.swarm_id, e.name, e.map_endpoint, e.auth_method);
      });
    } catch (err) {
      console.warn(`[openhive] Failed to register SwarmCraft plugin: ${(err as Error).message}`);
    }
  }

  // Initialize swarm hosting manager
  let swarmManager: SwarmManager | null = null;
  if (config.swarmHosting.enabled) {
    const instanceUrl = config.instance.url || `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
    swarmManager = new SwarmManager(config.swarmHosting as SwarmHostingConfig, instanceUrl);
    // Attach to fastify instance so routes can access it
    (fastify as unknown as { swarmManager: SwarmManager }).swarmManager = swarmManager;
    console.log('[openhive] Swarm hosting enabled');
  }

  // Serve skill.md
  fastify.get('/skill.md', async (_request, reply) => {
    const skillMd = generateSkillMd(config);
    return reply.type('text/markdown').send(skillMd);
  });

  // Serve sitemap.xml for SEO
  fastify.get('/sitemap.xml', async (_request, reply) => {
    const baseUrl = config.instance.url || `http://${config.host}:${config.port}`;
    const sitemap = generateSitemap({ baseUrl });
    return reply.type('application/xml').send(sitemap);
  });

  // Serve robots.txt for crawlers
  fastify.get('/robots.txt', async (_request, reply) => {
    const baseUrl = config.instance.url || `http://${config.host}:${config.port}`;
    const robotsTxt = generateRobotsTxt(baseUrl);
    return reply.type('text/plain').send(robotsTxt);
  });

  // Serve web UI static files (if they exist)
  // In dev mode (__dirname = src/), src/web has source files not built assets,
  // so we check for a built index.html to avoid serving raw .tsx files.
  const webPath = path.join(__dirname, 'web');
  const webPathAlt = path.join(__dirname, '..', 'dist', 'web');
  const actualWebPath =
    (fs.existsSync(path.join(webPath, 'assets')) ? webPath : null) ||
    (fs.existsSync(path.join(webPathAlt, 'index.html')) ? webPathAlt : null);

  // Track whether @fastify/static has been registered yet.
  // The first registration decorates the reply with sendFile(); subsequent ones must not.
  let staticRegistered = false;

  // Serve uploaded files from local storage
  if (config.storage?.type === 'local') {
    const uploadPath = path.resolve(config.storage.path);
    await fastify.register(fastifyStatic, {
      root: uploadPath,
      prefix: config.storage.publicUrl,
      decorateReply: !staticRegistered,
    });
    staticRegistered = true;
  }

  if (actualWebPath) {
    await fastify.register(fastifyStatic, {
      root: actualWebPath,
      prefix: '/',
      decorateReply: !staticRegistered,
    });
    staticRegistered = true;

    // SPA fallback for all non-API routes
    fastify.setNotFoundHandler((request, reply) => {
      // Don't serve SPA for API routes or skill.md
      if (request.url.startsWith('/api') || request.url === '/skill.md' || request.url.startsWith('/.well-known')) {
        return reply.status(404).send({ error: 'Not Found' });
      }
      // Serve index.html for SPA routes
      return reply.sendFile('index.html', actualWebPath);
    });
  } else {
    // Serve inline admin panel if no built web UI
    fastify.get('/', async (_request, reply) => {
      return reply.type('text/html').send(getWelcomeHtml(config));
    });
    fastify.get('/admin', async (_request, reply) => {
      return reply.type('text/html').send(getInlineAdminHtml(config));
    });
    fastify.get('/admin/*', async (_request, reply) => {
      return reply.type('text/html').send(getInlineAdminHtml(config));
    });
  }

  // Federation discovery (stub)
  fastify.get('/.well-known/openhive.json', async (_request, reply) => {
    // Get stats from database
    const db = require('./db/index.js').getDatabase();
    const agentCount = db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number };
    const postCount = db.prepare('SELECT COUNT(*) as count FROM posts').get() as { count: number };
    const hiveCount = db.prepare('SELECT COUNT(*) as count FROM hives').get() as { count: number };

    // Build response
    const wellKnown: Record<string, unknown> = {
      version: '0.2.0',
      name: config.instance.name,
      description: config.instance.description,
      url: config.instance.url,
      federation: {
        enabled: config.federation.enabled,
        protocol_version: '1.0',
      },
      stats: {
        agents: agentCount.count,
        posts: postCount.count,
        hives: hiveCount.count,
      },
      features: {
        swarm_hosting: config.swarmHosting.enabled,
        swarmcraft: config.swarmcraft.enabled,
      },
      endpoints: {
        api: '/api/v1',
        websocket: '/ws',
        skill: '/skill.md',
      },
    };

    // Add MAP Hub info if enabled
    if (config.mapHub.enabled) {
      try {
        const { getWellKnownMapInfo } = require('./map/service.js');
        Object.assign(wellKnown, getWellKnownMapInfo());
      } catch {
        // MAP module not available, skip
      }
    }

    return reply.send(wellKnown);
  });

  // Initialize mesh networking provider
  // Supports: tailscale-cloud, headscale-sidecar, headscale-external, none
  let networkProvider: NetworkProvider;

  if (config.network.provider !== 'none') {
    // Use the new network config
    networkProvider = createNetworkProvider(config.network);
  } else if (config.headscale.enabled) {
    // Backward compat: legacy headscale config maps to headscale-sidecar
    const serverUrl = config.headscale.serverUrl ||
      config.instance.url ||
      `http://${config.host}:${config.headscale.listenAddr.split(':')[1] || '8085'}`;

    networkProvider = createNetworkProvider({
      provider: 'headscale-sidecar',
      headscaleSidecar: {
        serverUrl,
        dataDir: config.headscale.dataDir,
        binaryPath: config.headscale.binaryPath,
        listenAddr: config.headscale.listenAddr,
        baseDomain: config.headscale.baseDomain,
        embeddedDerp: config.headscale.embeddedDerp,
      },
    });
  } else {
    networkProvider = createNetworkProvider({ provider: 'none' });
  }

  const server: HiveServer = {
    fastify,
    config,

    async start() {
      // Start mesh networking provider before listening
      if (networkProvider.type !== 'none') {
        try {
          await networkProvider.start();
          // Attach to fastify instance so routes can access it
          (fastify as unknown as { networkProvider: NetworkProvider }).networkProvider = networkProvider;
          console.log(`[openhive] Network provider started (${networkProvider.type})`);
        } catch (err) {
          console.warn(`[openhive] Network provider failed to start: ${(err as Error).message}`);
          console.warn('[openhive] MAP hub will work without L3/L4 mesh networking.');
        }
      }

      // Start sync service
      if (syncService) {
        syncService.start();
        console.log(`[openhive] Sync service started (instance: ${syncService.getInstanceId()})`);
      }

      // Start swarm hosting health monitor
      if (swarmManager) {
        swarmManager.startHealthMonitor();
        console.log('[openhive] Swarm hosting health monitor started');
      }

      const address = await fastify.listen({
        port: config.port,
        host: config.host,
      });
      return address;
    },

    async stop() {
      stopHeartbeat();
      // Stop hosted swarms
      if (swarmManager) {
        await swarmManager.shutdown();
      }
      // Stop sync service
      if (syncService) {
        syncService.stop();
      }
      // Stop mesh networking provider
      if (networkProvider.type !== 'none') {
        await networkProvider.stop();
      }
      await fastify.close();
      closeDatabase();
    },
  };

  return server;
}

function getWelcomeHtml(config: Config): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${config.instance.name}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Manrope:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Manrope', system-ui, sans-serif; background: #08080a; }
    body::before { content: ''; position: fixed; inset: 0; z-index: 0; pointer-events: none; background: radial-gradient(ellipse 80% 40% at 50% -10%, rgba(245,158,11,0.04), transparent 70%); }
    .accent-line { background: linear-gradient(90deg, transparent 0%, #b45309 20%, #f59e0b 40%, #fbbf24 50%, #f59e0b 60%, #b45309 80%, transparent 100%); }
    .glow-btn { box-shadow: 0 0 24px rgba(245,158,11,0.12), 0 1px 2px rgba(0,0,0,0.08); }
    .glow-btn:hover { box-shadow: 0 0 32px rgba(245,158,11,0.2), 0 4px 12px rgba(0,0,0,0.12); transform: translateY(-1px); }
  </style>
</head>
<body class="text-white min-h-screen flex flex-col">
  <div class="accent-line h-0.5 w-full"></div>
  <div class="flex-1 flex items-center justify-center relative z-10">
    <div class="text-center p-8 max-w-lg">
      <div class="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-amber-500/10 mb-6 ring-1 ring-amber-500/20">
        <span class="text-5xl">🐝</span>
      </div>
      <h1 class="text-4xl font-extrabold text-amber-400 mb-3 tracking-tight">${config.instance.name}</h1>
      <p class="text-zinc-400 mb-10 text-lg leading-relaxed">${config.instance.description}</p>
      <div class="space-y-5">
        <div class="flex gap-3 justify-center">
          <a href="/skill.md" class="glow-btn bg-amber-500 hover:bg-amber-400 text-black font-bold px-6 py-3 rounded-xl transition-all duration-200">View API Docs</a>
          <a href="/admin" class="bg-zinc-800/80 hover:bg-zinc-700/80 text-white font-bold px-6 py-3 rounded-xl border border-zinc-700/50 transition-all duration-200">Admin Panel</a>
        </div>
        <p class="text-sm text-zinc-600">Web UI not built. Run <code class="bg-zinc-800 px-2 py-1 rounded-lg text-amber-400/80 text-xs">npm run build:web</code> to build it.</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function getInlineAdminHtml(config: Config): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${config.instance.name} - Admin</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Manrope', system-ui, sans-serif; }
    .font-display { font-family: 'Instrument Serif', Georgia, serif; }
    .accent-line { background: linear-gradient(90deg, transparent 0%, #b45309 20%, #f59e0b 40%, #fbbf24 50%, #f59e0b 60%, #b45309 80%, transparent 100%); }
    .glow { box-shadow: 0 0 24px rgba(245,158,11,0.12), 0 1px 2px rgba(0,0,0,0.08); }
    .glow:hover { box-shadow: 0 0 32px rgba(245,158,11,0.2), 0 4px 12px rgba(0,0,0,0.12); }
    .stat-card { background: linear-gradient(135deg, rgba(245,158,11,0.06) 0%, transparent 60%); }
    ::selection { background-color: rgba(245,158,11,0.3); color: #fff; }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #222229; border-radius: 999px; }
    @keyframes fadeInUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    .animate-in { animation: fadeInUp 0.3s ease-out; }
  </style>
</head>
<body class="bg-[#08080a] text-[#e8e6e3] min-h-screen">
  <div id="root"></div>
  <script type="text/babel">
    const { useState, useEffect } = React;

    function App() {
      const [stats, setStats] = useState(null);
      const [agents, setAgents] = useState([]);
      const [invites, setInvites] = useState([]);
      const [adminKey, setAdminKey] = useState(localStorage.getItem('adminKey') || '');
      const [activeTab, setActiveTab] = useState('dashboard');
      const [error, setError] = useState(null);

      const headers = {
        'Content-Type': 'application/json',
        'X-Admin-Key': adminKey,
      };

      const fetchData = async () => {
        if (!adminKey) return;
        try {
          const [statsRes, agentsRes, invitesRes] = await Promise.all([
            fetch('/api/v1/admin/stats', { headers }),
            fetch('/api/v1/admin/agents?limit=100', { headers }),
            fetch('/api/v1/admin/invites?limit=100', { headers }),
          ]);

          if (!statsRes.ok) throw new Error('Invalid admin key');

          setStats(await statsRes.json());
          setAgents((await agentsRes.json()).data || []);
          setInvites((await invitesRes.json()).data || []);
          setError(null);
        } catch (err) {
          setError(err.message);
        }
      };

      useEffect(() => {
        if (adminKey) {
          localStorage.setItem('adminKey', adminKey);
          fetchData();
        }
      }, [adminKey]);

      const createInvite = async () => {
        await fetch('/api/v1/admin/invites', {
          method: 'POST',
          headers,
          body: JSON.stringify({ uses: 5 }),
        });
        fetchData();
      };

      const verifyAgent = async (id) => {
        await fetch(\`/api/v1/admin/agents/\${id}/verify\`, {
          method: 'POST',
          headers,
        });
        fetchData();
      };

      const rejectAgent = async (id) => {
        await fetch(\`/api/v1/admin/agents/\${id}/reject\`, {
          method: 'POST',
          headers,
        });
        fetchData();
      };

      if (!adminKey || error) {
        return (
          <div className="min-h-screen flex flex-col">
            <div className="accent-line h-0.5 w-full" />
            <div className="flex-1 flex items-center justify-center" style={{ background: 'radial-gradient(ellipse 80% 40% at 50% -10%, rgba(245,158,11,0.03), transparent 70%)' }}>
              <div className="bg-[#111114] border border-[#1f1f27] p-10 rounded-2xl shadow-2xl max-w-md w-full animate-in">
                <div className="text-center mb-8">
                  <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-amber-500/10 mb-4 ring-1 ring-amber-500/20">
                    <span className="text-3xl">🐝</span>
                  </div>
                  <h1 className="font-display text-3xl mb-1">${config.instance.name}</h1>
                  <p className="text-[#6e6a7a] text-sm">Admin Dashboard</p>
                </div>
                {error && (
                  <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl mb-4 text-sm">
                    {error}
                  </div>
                )}
                <input
                  type="password"
                  placeholder="Enter admin key"
                  value={adminKey}
                  onChange={(e) => setAdminKey(e.target.value)}
                  className="w-full p-3.5 bg-[#19191e] border border-[#1f1f27] rounded-xl mb-4 text-[#e8e6e3] placeholder-[#6e6a7a] focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500/30 transition-all"
                />
                <button
                  onClick={fetchData}
                  className="glow w-full bg-amber-500 hover:bg-amber-400 text-black font-bold py-3.5 rounded-xl transition-all duration-200 active:scale-[0.97]"
                >
                  Sign In
                </button>
              </div>
            </div>
          </div>
        );
      }

      const tabs = [
        { id: 'dashboard', label: 'Dashboard', icon: '📊' },
        { id: 'agents', label: 'Agents', icon: '🤖' },
        { id: 'invites', label: 'Invites', icon: '🔑' },
      ];

      const pendingCount = agents.filter(a => a.verification_status === 'pending').length;

      return (
        <div className="min-h-screen flex flex-col">
          <div className="accent-line h-0.5 w-full" />

          {/* Header */}
          <header className="border-b border-[#1f1f27] bg-[#111114]/80" style={{ backdropFilter: 'blur(20px)' }}>
            <div className="max-w-7xl mx-auto px-6 flex items-center justify-between h-16">
              <div className="flex items-center gap-3">
                <span className="text-xl">🐝</span>
                <span className="font-extrabold text-amber-500 tracking-tight text-lg">${config.instance.name}</span>
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500 border border-amber-500/20">Admin</span>
              </div>
              <button
                onClick={() => { setAdminKey(''); localStorage.removeItem('adminKey'); }}
                className="text-[#6e6a7a] hover:text-[#e8e6e3] text-sm font-medium transition-colors"
              >
                Sign out
              </button>
            </div>
          </header>

          <div className="flex-1 max-w-7xl mx-auto w-full px-6 py-8">
            {/* Navigation tabs */}
            <nav className="flex gap-1 p-1 bg-[#111114] border border-[#1f1f27] rounded-xl mb-8 w-fit">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={\`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200 \${
                    activeTab === tab.id
                      ? 'bg-amber-500 text-black'
                      : 'text-[#6e6a7a] hover:text-[#e8e6e3] hover:bg-[#19191e]'
                  }\`}
                >
                  <span>{tab.icon}</span>
                  {tab.label}
                  {tab.id === 'agents' && pendingCount > 0 && (
                    <span className="ml-1 px-1.5 py-0.5 text-xs rounded-full bg-red-500/20 text-red-400 font-medium">
                      {pendingCount}
                    </span>
                  )}
                </button>
              ))}
            </nav>

            {/* Dashboard */}
            {activeTab === 'dashboard' && stats && (
              <div className="animate-in">
                <h2 className="font-display text-2xl mb-6">Overview</h2>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 mb-8">
                  <div className="stat-card bg-[#111114] border border-[#1f1f27] p-6 rounded-2xl">
                    <div className="flex items-center justify-between mb-4">
                      <span className="text-xs font-semibold uppercase tracking-widest text-[#6e6a7a]">Agents</span>
                      <span className="text-2xl">🤖</span>
                    </div>
                    <div className="text-4xl font-extrabold text-amber-400 tracking-tight">{stats.agents?.total || 0}</div>
                    {stats.agents?.pending > 0 && (
                      <div className="text-xs text-amber-500/80 mt-2 font-medium">{stats.agents.pending} pending verification</div>
                    )}
                  </div>
                  <div className="stat-card bg-[#111114] border border-[#1f1f27] p-6 rounded-2xl">
                    <div className="flex items-center justify-between mb-4">
                      <span className="text-xs font-semibold uppercase tracking-widest text-[#6e6a7a]">Hives</span>
                      <span className="text-2xl">🐝</span>
                    </div>
                    <div className="text-4xl font-extrabold text-emerald-400 tracking-tight">{stats.hives?.total || 0}</div>
                  </div>
                  <div className="stat-card bg-[#111114] border border-[#1f1f27] p-6 rounded-2xl">
                    <div className="flex items-center justify-between mb-4">
                      <span className="text-xs font-semibold uppercase tracking-widest text-[#6e6a7a]">Posts</span>
                      <span className="text-2xl">💬</span>
                    </div>
                    <div className="text-4xl font-extrabold text-sky-400 tracking-tight">{stats.posts?.total || 0}</div>
                  </div>
                </div>

                {/* Quick info */}
                <div className="bg-[#111114] border border-[#1f1f27] rounded-2xl p-6">
                  <h3 className="font-semibold text-sm mb-4">Instance Info</h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-[#6e6a7a]">Name</span>
                      <p className="font-medium mt-0.5">${config.instance.name}</p>
                    </div>
                    <div>
                      <span className="text-[#6e6a7a]">Description</span>
                      <p className="font-medium mt-0.5">${config.instance.description}</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Agents */}
            {activeTab === 'agents' && (
              <div className="animate-in">
                <div className="flex items-center justify-between mb-6">
                  <h2 className="font-display text-2xl">Agents</h2>
                  <span className="text-sm text-[#6e6a7a]">{agents.length} total</span>
                </div>
                <div className="bg-[#111114] border border-[#1f1f27] rounded-2xl overflow-hidden">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-[#1f1f27]">
                        <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-widest text-[#6e6a7a]">Name</th>
                        <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-widest text-[#6e6a7a]">Type</th>
                        <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-widest text-[#6e6a7a]">Status</th>
                        <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-widest text-[#6e6a7a]">Karma</th>
                        <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-widest text-[#6e6a7a]">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agents.map(agent => (
                        <tr key={agent.id} className="border-t border-[#1f1f27] hover:bg-[#19191e] transition-colors">
                          <td className="px-5 py-4">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">
                                {agent.name.charAt(0).toUpperCase()}
                              </div>
                              <span className="font-medium">{agent.name}</span>
                            </div>
                          </td>
                          <td className="px-5 py-4">
                            <span className="text-sm text-[#6e6a7a]">{agent.account_type || 'agent'}</span>
                          </td>
                          <td className="px-5 py-4">
                            <span className={\`inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-semibold \${
                              agent.is_verified
                                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                : agent.verification_status === 'pending'
                                  ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                                  : 'bg-red-500/10 text-red-400 border border-red-500/20'
                            }\`}>
                              {agent.verification_status}
                            </span>
                          </td>
                          <td className="px-5 py-4">
                            <span className="font-medium tabular-nums">{agent.karma}</span>
                          </td>
                          <td className="px-5 py-4">
                            <div className="flex gap-2">
                              {!agent.is_verified && agent.verification_status === 'pending' && (
                                <>
                                  <button
                                    onClick={() => verifyAgent(agent.id)}
                                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors"
                                  >
                                    Verify
                                  </button>
                                  <button
                                    onClick={() => rejectAgent(agent.id)}
                                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
                                  >
                                    Reject
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {agents.length === 0 && (
                    <div className="text-center py-12 text-[#6e6a7a]">No agents registered yet</div>
                  )}
                </div>
              </div>
            )}

            {/* Invites */}
            {activeTab === 'invites' && (
              <div className="animate-in">
                <div className="flex items-center justify-between mb-6">
                  <h2 className="font-display text-2xl">Invite Codes</h2>
                  <button
                    onClick={createInvite}
                    className="glow bg-amber-500 hover:bg-amber-400 text-black font-bold px-5 py-2.5 rounded-xl text-sm transition-all duration-200 active:scale-[0.97]"
                  >
                    + Create Invite
                  </button>
                </div>
                <div className="bg-[#111114] border border-[#1f1f27] rounded-2xl overflow-hidden">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-[#1f1f27]">
                        <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-widest text-[#6e6a7a]">Code</th>
                        <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-widest text-[#6e6a7a]">Uses Left</th>
                        <th className="px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-widest text-[#6e6a7a]">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invites.map(invite => (
                        <tr key={invite.id} className="border-t border-[#1f1f27] hover:bg-[#19191e] transition-colors">
                          <td className="px-5 py-4">
                            <code className="font-mono text-sm text-amber-400 bg-amber-500/8 px-2.5 py-1 rounded-lg">{invite.code}</code>
                          </td>
                          <td className="px-5 py-4">
                            <span className="font-medium tabular-nums">{invite.uses_left}</span>
                          </td>
                          <td className="px-5 py-4 text-[#6e6a7a] text-sm">
                            {new Date(invite.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {invites.length === 0 && (
                    <div className="text-center py-12 text-[#6e6a7a]">No invite codes created yet</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      );
    }

    ReactDOM.createRoot(document.getElementById('root')).render(<App />);
  </script>
</body>
</html>`;
}

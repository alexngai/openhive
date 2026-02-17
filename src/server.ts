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

  // Serve uploaded files from local storage
  if (config.storage?.type === 'local') {
    const uploadPath = path.resolve(config.storage.path);
    await fastify.register(fastifyStatic, {
      root: uploadPath,
      prefix: config.storage.publicUrl,
      decorateReply: false,
    });
  }

  // Serve web UI static files (if they exist)
  const webPath = path.join(__dirname, 'web');
  const webPathAlt = path.join(__dirname, '..', 'dist', 'web');
  const actualWebPath = fs.existsSync(webPath) ? webPath : fs.existsSync(webPathAlt) ? webPathAlt : null;

  if (actualWebPath) {
    await fastify.register(fastifyStatic, {
      root: actualWebPath,
      prefix: '/',
      decorateReply: false,
    });

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
</head>
<body class="bg-gray-900 text-white min-h-screen flex items-center justify-center">
  <div class="text-center p-8">
    <div class="text-6xl mb-4">🐝</div>
    <h1 class="text-4xl font-bold text-amber-400 mb-2">${config.instance.name}</h1>
    <p class="text-gray-400 mb-8">${config.instance.description}</p>
    <div class="space-y-4">
      <p class="text-sm text-gray-500">Web UI not built. Run <code class="bg-gray-800 px-2 py-1 rounded">npm run build:web</code> to build it.</p>
      <div class="flex gap-4 justify-center">
        <a href="/skill.md" class="bg-amber-500 hover:bg-amber-600 text-black font-bold px-6 py-3 rounded-lg">View API Docs</a>
        <a href="/admin" class="bg-gray-700 hover:bg-gray-600 text-white font-bold px-6 py-3 rounded-lg">Admin Panel</a>
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
</head>
<body class="bg-gray-900 text-white min-h-screen">
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

      if (!adminKey || error) {
        return (
          <div className="flex items-center justify-center min-h-screen">
            <div className="bg-gray-800 p-8 rounded-lg shadow-xl max-w-md w-full">
              <h1 className="text-2xl font-bold mb-6 text-center">${config.instance.name} Admin</h1>
              {error && <p className="text-red-400 mb-4">{error}</p>}
              <input
                type="password"
                placeholder="Admin Key"
                value={adminKey}
                onChange={(e) => setAdminKey(e.target.value)}
                className="w-full p-3 bg-gray-700 rounded mb-4 text-white"
              />
              <button
                onClick={fetchData}
                className="w-full bg-amber-500 hover:bg-amber-600 text-black font-bold py-3 rounded"
              >
                Login
              </button>
            </div>
          </div>
        );
      }

      return (
        <div className="max-w-6xl mx-auto p-6">
          <header className="flex justify-between items-center mb-8">
            <h1 className="text-3xl font-bold text-amber-400">${config.instance.name}</h1>
            <button
              onClick={() => { setAdminKey(''); localStorage.removeItem('adminKey'); }}
              className="text-gray-400 hover:text-white"
            >
              Logout
            </button>
          </header>

          <nav className="flex gap-4 mb-8 border-b border-gray-700 pb-4">
            {['dashboard', 'agents', 'invites'].map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={\`px-4 py-2 rounded \${activeTab === tab ? 'bg-amber-500 text-black' : 'text-gray-400 hover:text-white'}\`}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </nav>

          {activeTab === 'dashboard' && stats && (
            <div className="grid grid-cols-3 gap-6">
              <div className="bg-gray-800 p-6 rounded-lg">
                <div className="text-4xl font-bold text-amber-400">{stats.agents?.total || 0}</div>
                <div className="text-gray-400">Agents</div>
              </div>
              <div className="bg-gray-800 p-6 rounded-lg">
                <div className="text-4xl font-bold text-green-400">{stats.hives?.total || 0}</div>
                <div className="text-gray-400">Hives</div>
              </div>
              <div className="bg-gray-800 p-6 rounded-lg">
                <div className="text-4xl font-bold text-blue-400">{stats.posts?.total || 0}</div>
                <div className="text-gray-400">Posts</div>
              </div>
            </div>
          )}

          {activeTab === 'agents' && (
            <div className="bg-gray-800 rounded-lg overflow-hidden">
              <table className="w-full">
                <thead className="bg-gray-700">
                  <tr>
                    <th className="p-4 text-left">Name</th>
                    <th className="p-4 text-left">Status</th>
                    <th className="p-4 text-left">Karma</th>
                    <th className="p-4 text-left">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map(agent => (
                    <tr key={agent.id} className="border-t border-gray-700">
                      <td className="p-4">{agent.name}</td>
                      <td className="p-4">
                        <span className={\`px-2 py-1 rounded text-sm \${agent.is_verified ? 'bg-green-600' : 'bg-yellow-600'}\`}>
                          {agent.verification_status}
                        </span>
                      </td>
                      <td className="p-4">{agent.karma}</td>
                      <td className="p-4">
                        {!agent.is_verified && (
                          <button
                            onClick={() => verifyAgent(agent.id)}
                            className="bg-green-600 hover:bg-green-700 px-3 py-1 rounded text-sm"
                          >
                            Verify
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'invites' && (
            <div>
              <button
                onClick={createInvite}
                className="bg-amber-500 hover:bg-amber-600 text-black font-bold px-4 py-2 rounded mb-4"
              >
                Create Invite Code
              </button>
              <div className="bg-gray-800 rounded-lg overflow-hidden">
                <table className="w-full">
                  <thead className="bg-gray-700">
                    <tr>
                      <th className="p-4 text-left">Code</th>
                      <th className="p-4 text-left">Uses Left</th>
                      <th className="p-4 text-left">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invites.map(invite => (
                      <tr key={invite.id} className="border-t border-gray-700">
                        <td className="p-4 font-mono">{invite.code}</td>
                        <td className="p-4">{invite.uses_left}</td>
                        <td className="p-4">{new Date(invite.created_at).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      );
    }

    ReactDOM.createRoot(document.getElementById('root')).render(<App />);
  </script>
</body>
</html>`;
}

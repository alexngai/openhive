import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import * as path from 'path';
import * as fs from 'fs';
import { Config, loadConfig } from './config.js';
import { initDatabase, closeDatabase } from './db/index.js';
import { registerRoutes } from './api/index.js';
import { setupWebSocket, stopHeartbeat } from './realtime/index.js';
import { generateSkillMd } from './skill.js';

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

  // Register WebSocket
  await fastify.register(websocket);

  // Setup WebSocket handlers
  setupWebSocket(fastify);

  // Register API routes
  await registerRoutes(fastify, config);

  // Serve skill.md
  fastify.get('/skill.md', async (_request, reply) => {
    const skillMd = generateSkillMd(config);
    return reply.type('text/markdown').send(skillMd);
  });

  // Serve admin panel static files (if they exist)
  const adminPath = path.join(__dirname, 'admin', 'dist');
  if (fs.existsSync(adminPath)) {
    await fastify.register(fastifyStatic, {
      root: adminPath,
      prefix: '/admin/',
      decorateReply: false,
    });

    // SPA fallback for admin routes
    fastify.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/admin')) {
        return reply.sendFile('index.html', adminPath);
      }
      return reply.status(404).send({ error: 'Not Found' });
    });
  } else {
    // Serve inline admin panel if no built files
    fastify.get('/admin', async (_request, reply) => {
      return reply.type('text/html').send(getInlineAdminHtml(config));
    });
    fastify.get('/admin/*', async (_request, reply) => {
      return reply.type('text/html').send(getInlineAdminHtml(config));
    });
  }

  // Federation discovery (stub)
  fastify.get('/.well-known/openhive.json', async (_request, reply) => {
    return reply.send({
      version: '0.1.0',
      name: config.instance.name,
      description: config.instance.description,
      url: config.instance.url,
      federation: {
        enabled: config.federation.enabled,
        protocol_version: '1.0',
      },
      endpoints: {
        api: '/api/v1',
        websocket: '/ws',
        skill: '/skill.md',
      },
    });
  });

  const server: HiveServer = {
    fastify,
    config,

    async start() {
      const address = await fastify.listen({
        port: config.port,
        host: config.host,
      });
      return address;
    },

    async stop() {
      stopHeartbeat();
      await fastify.close();
      closeDatabase();
    },
  };

  return server;
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

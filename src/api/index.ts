import { FastifyInstance } from 'fastify';
import { agentsRoutes } from './routes/agents.js';
import { hivesRoutes } from './routes/hives.js';
import { postsRoutes } from './routes/posts.js';
import { commentsRoutes } from './routes/comments.js';
import { feedRoutes } from './routes/feed.js';
import { searchRoutes } from './routes/search.js';
import { uploadsRoutes } from './routes/uploads.js';
import { authRoutes } from './routes/auth.js';
import { federationRoutes } from './routes/federation.js';
import { adminRoutes } from './routes/admin.js';
import { memoryBanksRoutes } from './routes/memory-banks.js';
import { resourcesRoutes } from './routes/resources.js';
import { resourceContentRoutes } from './routes/resource-content.js';
import { webhooksRoutes } from './routes/webhooks.js';
import { sessionsRoutes } from './routes/sessions.js';
import { mapRoutes } from './routes/map.js';
import { swarmHostingRoutes } from './routes/swarm-hosting.js';
import { syncRoutes } from './routes/sync.js';
import { bridgesRoutes } from './routes/bridges.js';
import { eventsRoutes } from './routes/events.js';
import type { Config } from '../config.js';
import type { BridgeManager } from '../bridge/manager.js';
import type { SwarmHubConnector } from '../swarmhub/connector.js';

export async function registerRoutes(fastify: FastifyInstance, config: Config, bridgeManager?: BridgeManager, swarmhubConnector?: SwarmHubConnector | null): Promise<void> {
  // Health check
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // API v1 routes
  await fastify.register(
    async (api) => {
      await api.register(agentsRoutes, { config });
      await api.register(hivesRoutes);
      await api.register(postsRoutes);
      await api.register(commentsRoutes);
      await api.register(feedRoutes);
      await api.register(searchRoutes);
      await api.register(uploadsRoutes);
      await api.register(authRoutes, { config: { authMode: config.auth.mode, swarmhubApiUrl: config.swarmhub.apiUrl || process.env.SWARMHUB_API_URL, swarmhubOAuthClientId: config.swarmhub.oauth.clientId, swarmhubOAuthClientSecret: config.swarmhub.oauth.clientSecret } });
      await api.register(federationRoutes, { config });
      await api.register(adminRoutes, { config });
      await api.register(memoryBanksRoutes, { config });
      await api.register(resourcesRoutes, { config });
      await api.register(resourceContentRoutes, { config });
      await api.register(webhooksRoutes, { config });
      await api.register(sessionsRoutes, { config });
      await api.register(mapRoutes, { config });
      await api.register(swarmHostingRoutes, { config });
      await api.register(syncRoutes, { config });
      await api.register(bridgesRoutes, { config, bridgeManager });
      await api.register(eventsRoutes);
      if (swarmhubConnector) {
        const { swarmhubRoutes, swarmhubWebhookRoutes } = await import('../swarmhub/routes.js');
        await api.register(swarmhubRoutes, { connector: swarmhubConnector });
        await api.register(swarmhubWebhookRoutes, { connector: swarmhubConnector });
      }
    },
    { prefix: '/api/v1' }
  );
}

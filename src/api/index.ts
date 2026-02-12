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
import { webhooksRoutes } from './routes/webhooks.js';
import { sessionsRoutes } from './routes/sessions.js';
import { mapRoutes } from './routes/map.js';
import { syncRoutes } from './routes/sync.js';
import type { Config } from '../config.js';

export async function registerRoutes(fastify: FastifyInstance, config: Config): Promise<void> {
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
      await api.register(authRoutes, { config: { jwtSecret: config.jwt.secret!, instanceUrl: config.instance.url } });
      await api.register(federationRoutes, { config });
      await api.register(adminRoutes, { config });
      await api.register(memoryBanksRoutes, { config });
      await api.register(resourcesRoutes, { config });
      await api.register(webhooksRoutes, { config });
      await api.register(sessionsRoutes, { config });
      await api.register(mapRoutes, { config });
      await api.register(syncRoutes, { config });
    },
    { prefix: '/api/v1' }
  );
}

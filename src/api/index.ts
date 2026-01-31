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
      await api.register(authRoutes, { config: { jwtSecret: config.jwt.secret! } });
      await api.register(federationRoutes, { config });
      await api.register(adminRoutes, { config });
    },
    { prefix: '/api/v1' }
  );
}

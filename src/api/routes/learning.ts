import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { broadcastToChannel } from '../../realtime/index.js';
import type { Config } from '../../config.js';
import type { AtlasService } from '../../learning/atlas-service.js';

// ============================================================================
// Validation Schemas
// ============================================================================

const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const PlaybookQuerySchema = PaginationSchema.extend({
  domain: z.string().optional(),
  sort: z.enum(['confidence', 'recency', 'usage']).default('confidence'),
});

const KnowledgeQuerySchema = PaginationSchema.extend({
  type: z.enum(['observation', 'entity', 'domain-summary']).optional(),
  domain: z.string().optional(),
  search: z.string().optional(),
});

const ExperienceQuerySchema = PaginationSchema.extend({
  domain: z.string().optional(),
});

// ============================================================================
// Routes
// ============================================================================

export async function learningRoutes(
  fastify: FastifyInstance,
  _options: { config: Config },
): Promise<void> {

  function getAtlasService(): AtlasService {
    const svc = (fastify as unknown as { atlasService?: AtlasService }).atlasService;
    if (!svc?.isAvailable()) {
      const err = new Error('Learning engine is not available') as Error & { statusCode: number };
      err.statusCode = 503;
      throw err;
    }
    return svc;
  }

  // GET /learning/stats
  fastify.get('/learning/stats', async (_request, reply) => {
    const svc = getAtlasService();
    const stats = await svc.getStats();
    return reply.send(stats);
  });

  // GET /learning/playbooks
  fastify.get('/learning/playbooks', async (request, reply) => {
    const svc = getAtlasService();
    const params = PlaybookQuerySchema.parse(request.query);
    const memory = svc.getMemory();
    if (!memory) {
      return reply.send({ data: [], total: 0, limit: params.limit, offset: params.offset });
    }

    const all = await memory.playbooks.getAll();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let filtered = all as any[];
    if (params.domain) {
      filtered = filtered.filter(p => p.applicability?.domains?.includes(params.domain));
    }

    if (params.sort === 'confidence') {
      filtered.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    } else if (params.sort === 'recency') {
      filtered.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    } else if (params.sort === 'usage') {
      filtered.sort((a, b) => (b.evolution?.successCount ?? 0) - (a.evolution?.successCount ?? 0));
    }

    const total = filtered.length;
    const data = filtered.slice(params.offset, params.offset + params.limit);

    return reply.send({ data, total, limit: params.limit, offset: params.offset });
  });

  // GET /learning/playbooks/:id
  fastify.get('/learning/playbooks/:id', async (request, reply) => {
    const svc = getAtlasService();
    const { id } = request.params as { id: string };
    const memory = svc.getMemory();
    if (!memory) {
      return reply.status(404).send({ error: 'Playbook not found' });
    }
    const playbook = await memory.playbooks.get(id);
    if (!playbook) {
      return reply.status(404).send({ error: 'Playbook not found' });
    }
    return reply.send(playbook);
  });

  // GET /learning/knowledge
  fastify.get('/learning/knowledge', async (request, reply) => {
    const svc = getAtlasService();
    const params = KnowledgeQuerySchema.parse(request.query);
    const kb = svc.getKnowledgeBank();

    if (!kb) {
      return reply.send({ data: [], total: 0, limit: params.limit, offset: params.offset });
    }

    // Use knowledge bank search if available
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kbAny = kb as any;
    if (params.search && kbAny.search) {
      const results = await kbAny.search(params.search, { limit: params.limit });
      return reply.send({
        data: results?.matches || results?.notes || [],
        total: results?.matches?.length || results?.notes?.length || 0,
        limit: params.limit,
        offset: params.offset,
      });
    }

    // Fallback: get stats
    if (kbAny.getStats) {
      const stats = await kbAny.getStats();
      return reply.send({
        data: [],
        total: stats?.observationCount ?? 0,
        limit: params.limit,
        offset: params.offset,
      });
    }

    return reply.send({ data: [], total: 0, limit: params.limit, offset: params.offset });
  });

  // GET /learning/knowledge/:id
  fastify.get('/learning/knowledge/:id', async (request, reply) => {
    const svc = getAtlasService();
    const { id } = request.params as { id: string };
    const kb = svc.getKnowledgeBank();

    if (!kb) {
      return reply.status(404).send({ error: 'Knowledge bank not available' });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kbAny = kb as any;
    if (kbAny.getNote) {
      const note = await kbAny.getNote(id);
      if (!note) {
        return reply.status(404).send({ error: 'Knowledge note not found' });
      }
      return reply.send(note);
    }

    return reply.status(404).send({ error: 'Knowledge note not found' });
  });

  // GET /learning/experiences
  fastify.get('/learning/experiences', async (request, reply) => {
    const svc = getAtlasService();
    const params = ExperienceQuerySchema.parse(request.query);
    const memory = svc.getMemory();
    if (!memory) {
      return reply.send({ data: [], total: 0, limit: params.limit, offset: params.offset });
    }

    const all = await memory.experiences.getAll();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let filtered = all as any[];
    if (params.domain) {
      filtered = filtered.filter(e => e.task?.domain === params.domain);
    }

    // Sort by recency
    filtered.sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')));

    const total = filtered.length;
    const data = filtered.slice(params.offset, params.offset + params.limit);

    return reply.send({ data, total, limit: params.limit, offset: params.offset });
  });

  // POST /learning/batch (admin only)
  fastify.post('/learning/batch', async (_request, reply) => {
    const svc = getAtlasService();
    const result = await svc.runBatchLearning();
    return reply.send(result);
  });

  // POST /learning/maintenance (admin only)
  fastify.post('/learning/maintenance', async (_request, reply) => {
    const svc = getAtlasService();
    const learning = svc.getLearning();

    if (!learning) {
      return reply.status(501).send({ error: 'Learning pipeline not available' });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pipeline = learning as any;
    if (!pipeline.runMaintenance) {
      return reply.status(501).send({ error: 'Maintenance not supported' });
    }

    const result = await pipeline.runMaintenance();

    broadcastToChannel('learning', {
      type: 'learning:maintenance',
      data: result,
    });

    return reply.send(result);
  });

  // GET /learning/health
  fastify.get('/learning/health', async (_request, reply) => {
    const svc = (fastify as unknown as { atlasService?: AtlasService }).atlasService;
    const available = svc?.isAvailable() ?? false;

    if (!available) {
      return reply.send({
        available: false,
        reason: svc ? 'Atlas initialization failed' : 'Learning engine disabled',
      });
    }

    const stats = await svc!.getStats() as {
      learning?: { trajectoriesProcessed?: number; pendingTrajectories?: number };
      memory?: { experienceCount?: number; playbookCount?: number };
    };

    // Check if agentic compute is enabled
    const atlas = svc!.getAtlas();
    const hasAgentExecution = atlas ? atlas.hasAgentExecution() : false;

    return reply.send({
      available: true,
      agentic_compute: hasAgentExecution,
      trajectories_processed: stats.learning?.trajectoriesProcessed ?? 0,
      pending_trajectories: stats.learning?.pendingTrajectories ?? 0,
      experience_count: stats.memory?.experienceCount ?? 0,
      playbook_count: stats.memory?.playbookCount ?? 0,
    });
  });
}

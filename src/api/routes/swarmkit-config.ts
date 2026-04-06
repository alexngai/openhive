/**
 * SwarmKit configuration API routes.
 *
 * Exposes endpoints for reading and writing SwarmKit package configs
 * through the OpenHive admin interface. All routes require admin auth.
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { SwarmKitConfigManager } from '../../swarmkit/manager.js';
import { getNestedValue, setNestedValue } from '../../swarmkit/utils.js';
import { resolveDataDir } from '../../data-dir.js';
import type { Config } from '../../config.js';
import type { PackageScope } from '../../swarmkit/types.js';

const SECRET_SENTINEL = '********';

// ─── Request body schemas ───────────────────────────────────

const addProjectSchema = z.object({
  path: z.string().min(1),
});

const updatePackageSchema = z.object({
  scope: z.enum(['global', 'project']),
  updates: z.record(z.unknown()),
  projectRoot: z.string().optional(),
});

const updateSharedSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  projectRoot: z.string().optional(),
});

const updateIntegrationSchema = z.object({
  updates: z.record(z.unknown()),
  projectRoot: z.string().optional(),
});

const initPackageSchema = z.object({
  scope: z.enum(['global', 'project']),
  projectRoot: z.string().optional(),
  overrides: z.record(z.unknown()).optional(),
});

const initAllSchema = z.object({
  projectRoot: z.string().min(1),
  overrides: z.record(z.record(z.unknown())).optional(),
});

export async function swarmkitConfigRoutes(
  fastify: FastifyInstance,
  options: { config: Config },
): Promise<void> {
  const dataDir = resolveDataDir();
  const manager = new SwarmKitConfigManager(dataDir);
  manager.initialize();

  const adminAuth = async (
    request: Parameters<typeof authMiddleware>[0],
    reply: Parameters<typeof authMiddleware>[1],
  ) => {
    const adminKey = request.headers['x-admin-key'];
    if (adminKey && options.config.admin.key && adminKey === options.config.admin.key) {
      return;
    }
    await authMiddleware(request, reply);
    if (reply.sent) return;
    requireAdmin(request, reply);
  };

  // ─── Status ───────────────────────────────────────────────

  fastify.get('/admin/swarmkit/status', {
    preHandler: adminAuth,
  }, async () => {
    return manager.getState();
  });

  // ─── Project roots ────────────────────────────────────────

  fastify.get('/admin/swarmkit/projects', {
    preHandler: adminAuth,
  }, async () => {
    return { projectRoots: manager.getProjectRoots() };
  });

  fastify.post('/admin/swarmkit/projects', {
    preHandler: adminAuth,
  }, async (request, reply) => {
    const parsed = addProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }
    const { path: projectPath } = parsed.data;
    try {
      manager.addProjectRoot(projectPath);
      return { success: true, projectRoots: manager.getProjectRoots() };
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  fastify.delete('/admin/swarmkit/projects/:encoded', {
    preHandler: adminAuth,
  }, async (request) => {
    const { encoded } = request.params as { encoded: string };
    const projectPath = Buffer.from(encoded, 'base64url').toString('utf-8');
    manager.removeProjectRoot(projectPath);
    return { success: true, projectRoots: manager.getProjectRoots() };
  });

  // ─── Package configs ──────────────────────────────────────

  fastify.get('/admin/swarmkit/packages', {
    preHandler: adminAuth,
  }, async (request) => {
    const { projectRoot } = request.query as { projectRoot?: string };
    const packages = manager.getAllPackageConfigs(projectRoot ?? null);
    return {
      packages: packages.map((pkg) => ({
        ...pkg,
        config: redactSecrets(pkg.config, pkg.meta.fields),
      })),
    };
  });

  fastify.get('/admin/swarmkit/packages/:name', {
    preHandler: adminAuth,
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { projectRoot, scope } = request.query as {
      projectRoot?: string;
      scope?: PackageScope;
    };

    const pkg = manager.getPackageConfig(name, projectRoot ?? null, scope);
    if (!pkg) {
      return reply.status(404).send({ error: `Unknown package: ${name}` });
    }

    return {
      ...pkg,
      config: redactSecrets(pkg.config, pkg.meta.fields),
    };
  });

  fastify.patch('/admin/swarmkit/packages/:name', {
    preHandler: adminAuth,
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const parsed = updatePackageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }
    const { scope, updates, projectRoot } = parsed.data;

    // Strip sentinel values (don't overwrite secrets)
    const cleaned = stripSentinels(updates);

    const result = manager.updatePackageConfig(
      name,
      projectRoot ?? null,
      scope,
      cleaned,
    );

    if (!result.success) {
      return reply.status(400).send({ error: result.message });
    }

    // Return updated config
    const pkg = manager.getPackageConfig(name, projectRoot ?? null, scope);
    return pkg
      ? { ...pkg, config: redactSecrets(pkg.config, pkg.meta.fields) }
      : { success: true };
  });

  // ─── Shared settings ─────────────────────────────────────

  fastify.get('/admin/swarmkit/shared', {
    preHandler: adminAuth,
  }, async (request) => {
    const { projectRoot } = request.query as { projectRoot?: string };
    return {
      settings: manager.getSharedSettings(projectRoot ?? null),
    };
  });

  fastify.patch('/admin/swarmkit/shared', {
    preHandler: adminAuth,
  }, async (request, reply) => {
    const parsed = updateSharedSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }
    const { key, value, projectRoot } = parsed.data;

    // Don't propagate sentinel values
    if (value === SECRET_SENTINEL) {
      return { results: [], skipped: true };
    }

    const results = manager.updateSharedSetting(key, value, projectRoot ?? null);
    return { results };
  });

  // ─── Integrations ─────────────────────────────────────────

  fastify.get('/admin/swarmkit/integrations', {
    preHandler: adminAuth,
  }, async (request) => {
    const { projectRoot } = request.query as { projectRoot?: string };
    return {
      integrations: manager.getIntegrations(projectRoot ?? null),
    };
  });

  fastify.patch('/admin/swarmkit/integrations/:id', {
    preHandler: adminAuth,
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateIntegrationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }
    const { updates, projectRoot } = parsed.data;

    const result = manager.updateIntegration(id, updates, projectRoot ?? null);
    if (!result.success) {
      return reply.status(400).send({ error: result.message });
    }

    return { success: true };
  });

  // ─── Package initialization ────────────────────────────────

  fastify.get('/admin/swarmkit/init-status', {
    preHandler: adminAuth,
  }, async (request, reply) => {
    const { projectRoot } = request.query as { projectRoot?: string };
    if (!projectRoot) {
      return reply.status(400).send({ error: 'projectRoot is required' });
    }
    return { status: manager.getInitStatus(projectRoot) };
  });

  fastify.post('/admin/swarmkit/init/:name', {
    preHandler: adminAuth,
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const parsed = initPackageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }
    const { scope, projectRoot, overrides } = parsed.data;

    const result = manager.initPackage(name, projectRoot ?? null, scope, overrides);
    if (!result.success) {
      return reply.status(400).send({ error: result.message });
    }

    return result;
  });

  fastify.post('/admin/swarmkit/init-all', {
    preHandler: adminAuth,
  }, async (request, reply) => {
    const parsed = initAllSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }
    const { projectRoot, overrides } = parsed.data;

    const results = manager.initAllPackages(projectRoot, overrides);
    return {
      results,
      summary: {
        total: results.length,
        success: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
      },
    };
  });

  // ─── Doctor ───────────────────────────────────────────────

  fastify.get('/admin/swarmkit/doctor', {
    preHandler: adminAuth,
  }, async (request) => {
    const { projectRoot } = request.query as { projectRoot?: string };
    return {
      results: manager.runDoctor(projectRoot ?? null),
    };
  });
}

// ─── Helpers ──────────────────────────────────────────────────

function redactSecrets(
  config: Record<string, unknown>,
  fields: Record<string, { secret?: boolean }>,
): Record<string, unknown> {
  const result = structuredClone(config);
  for (const [key, meta] of Object.entries(fields)) {
    if (!meta.secret) continue;
    const value = getNestedValue(result, key);
    if (value !== undefined && value !== null && value !== '') {
      setNestedValue(result, key, SECRET_SENTINEL);
    }
  }
  return result;
}

function stripSentinels(updates: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value === SECRET_SENTINEL) continue;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const cleaned = stripSentinels(value as Record<string, unknown>);
      if (Object.keys(cleaned).length > 0) {
        result[key] = cleaned;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}


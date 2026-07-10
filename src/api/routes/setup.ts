/**
 * Setup + doctor admin API — the HTTP consumers of the setup engine
 * (src/setup/). Same sections the CLI (`openhive setup`, `openhive
 * doctor`) drives in-process; these routes back the web onboarding page.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createAdminAuth } from '../middleware/auth.js';
import type { Config } from '../../config.js';
import { resolveDataDir } from '../../data-dir.js';
import {
  buildSetupContext,
  getSection,
  refreshContext,
  runDoctor,
  statusAll,
} from '../../setup/registry.js';
import type { SectionReport } from '../../setup/registry.js';

function redactSecrets(reports: SectionReport[]): SectionReport[] {
  return reports.map((report) => ({
    ...report,
    fields: report.fields.map((field) =>
      field.type === 'secret' && field.current
        ? { ...field, current: '••••••••' }
        : field,
    ),
  }));
}

const applyBodySchema = z.object({
  answers: z.record(z.string(), z.unknown()).default({}),
});

export async function setupRoutes(
  fastify: FastifyInstance,
  options: { config: Config },
): Promise<void> {
  const adminAuth = createAdminAuth(options.config);

  // GET /admin/setup — section list with status + field specs
  fastify.get('/admin/setup', { preHandler: adminAuth }, async () => {
    const ctx = await buildSetupContext(resolveDataDir());
    return { sections: redactSecrets(await statusAll(ctx)) };
  });

  // POST /admin/setup/:id — apply answers to one section
  fastify.post<{ Params: { id: string } }>(
    '/admin/setup/:id',
    { preHandler: adminAuth },
    async (request, reply) => {
      const section = getSection(request.params.id);
      if (!section) {
        return reply.status(404).send({
          error: 'Not Found',
          message: `Unknown setup section "${request.params.id}"`,
        });
      }
      const parsed = applyBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          details: parsed.error.issues,
        });
      }

      const ctx = await buildSetupContext(resolveDataDir());
      try {
        const result = await section.apply(ctx, parsed.data.answers);
        await refreshContext(ctx);
        return {
          ...result,
          status: await section.status(ctx),
        };
      } catch (err) {
        return reply.status(500).send({
          error: 'Apply Failed',
          message: (err as Error).message,
        });
      }
    },
  );

  // GET /admin/doctor?deep=true — hub-wide health checks
  fastify.get<{ Querystring: { deep?: string } }>(
    '/admin/doctor',
    { preHandler: adminAuth },
    async (request) => {
      const deep = request.query.deep === 'true' || request.query.deep === '1';
      const ctx = await buildSetupContext(resolveDataDir());
      return { results: await runDoctor(ctx, { deep }) };
    },
  );
}

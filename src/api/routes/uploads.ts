import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import * as uploadsDAL from '../../db/dal/uploads.js';
import * as agentsDAL from '../../db/dal/agents.js';
import {
  getStorage,
  isStorageInitialized,
  validateUpload,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
} from '../../storage/index.js';

const UploadQuerySchema = z.object({
  purpose: z.enum(['avatar', 'banner', 'post', 'comment']),
});

export async function uploadsRoutes(fastify: FastifyInstance): Promise<void> {
  // Upload a file
  fastify.post('/uploads', { preHandler: authMiddleware }, async (request, reply) => {
    if (!isStorageInitialized()) {
      return reply.status(503).send({
        error: 'Storage Not Configured',
        message: 'File uploads are not enabled on this instance',
      });
    }

    const data = await request.file();
    if (!data) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'No file provided',
      });
    }

    // Get purpose from query
    const parseResult = UploadQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parseResult.error.issues,
      });
    }

    const { purpose } = parseResult.data;
    const agent = request.agent!;

    // Validate file
    const buffer = await data.toBuffer();
    const mimeType = data.mimetype;
    const validation = validateUpload(mimeType, buffer.length);

    if (!validation.valid) {
      return reply.status(400).send({
        error: 'Invalid File',
        message: validation.error,
      });
    }

    try {
      const storage = getStorage();

      // Upload file
      const result = await storage.upload(buffer, {
        filename: data.filename,
        mimeType,
        agentId: agent.id,
        purpose,
      });

      // Save to database
      const upload = uploadsDAL.createUpload({
        agent_id: agent.id,
        key: result.key,
        url: result.url,
        thumbnail_url: result.thumbnailUrl,
        purpose,
        mime_type: result.mimeType,
        size: result.size,
        width: result.width,
        height: result.height,
      });

      // If this is an avatar or banner, update the agent's avatar_url
      if (purpose === 'avatar') {
        agentsDAL.updateAgent(agent.id, { avatar_url: result.url });
      }

      return reply.status(201).send({
        id: upload.id,
        url: upload.url,
        thumbnail_url: upload.thumbnail_url,
        width: upload.width,
        height: upload.height,
        size: upload.size,
        mime_type: upload.mime_type,
      });
    } catch (error) {
      fastify.log.error(error, 'Upload failed');
      return reply.status(500).send({
        error: 'Upload Failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // List uploads for the authenticated agent
  fastify.get('/uploads', { preHandler: authMiddleware }, async (request, reply) => {
    const agent = request.agent!;

    const query = request.query as { purpose?: string; limit?: string; offset?: string };
    const uploads = uploadsDAL.listUploadsByAgent(agent.id, {
      purpose: query.purpose,
      limit: query.limit ? parseInt(query.limit, 10) : 50,
      offset: query.offset ? parseInt(query.offset, 10) : 0,
    });

    const stats = uploadsDAL.getUploadStats(agent.id);

    return reply.send({
      data: uploads,
      stats,
    });
  });

  // Delete an upload
  fastify.delete('/uploads/:id', { preHandler: authMiddleware }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = request.agent!;

    const upload = uploadsDAL.findUploadById(id);

    if (!upload) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Upload not found',
      });
    }

    if (upload.agent_id !== agent.id && !agent.is_admin) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You can only delete your own uploads',
      });
    }

    try {
      if (isStorageInitialized()) {
        const storage = getStorage();
        await storage.delete(upload.key);
      }

      uploadsDAL.deleteUpload(id);

      return reply.status(204).send();
    } catch (error) {
      fastify.log.error(error, 'Delete upload failed');
      return reply.status(500).send({
        error: 'Delete Failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Get upload info endpoint (for embedding metadata)
  fastify.get('/uploads/info', async (_request, reply) => {
    return reply.send({
      enabled: isStorageInitialized(),
      max_size: MAX_FILE_SIZE,
      allowed_types: ALLOWED_MIME_TYPES,
      purposes: ['avatar', 'banner', 'post', 'comment'],
    });
  });
}

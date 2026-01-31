import { FastifyInstance } from 'fastify';
import { ListPostsQuerySchema } from '../schemas/posts.js';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import * as postsDAL from '../../db/dal/posts.js';
import * as hivesDAL from '../../db/dal/hives.js';
import { getDatabase } from '../../db/index.js';

export async function feedRoutes(fastify: FastifyInstance): Promise<void> {
  // Get personalized feed (from joined hives and followed agents)
  fastify.get('/feed', { preHandler: authMiddleware }, async (request, reply) => {
    const parseResult = ListPostsQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parseResult.error.issues,
      });
    }

    const { sort, limit, offset } = parseResult.data;
    const agentId = request.agent!.id;
    const db = getDatabase();

    // Get posts from joined hives and followed agents
    let query = `
      SELECT DISTINCT
        p.*,
        a.name as author_name,
        a.description as author_description,
        a.avatar_url as author_avatar_url,
        a.karma as author_karma,
        a.is_verified as author_is_verified,
        a.created_at as author_created_at,
        h.name as hive_name,
        v.value as user_vote
      FROM posts p
      JOIN agents a ON p.author_id = a.id
      JOIN hives h ON p.hive_id = h.id
      LEFT JOIN votes v ON v.target_type = 'post' AND v.target_id = p.id AND v.agent_id = ?
      LEFT JOIN memberships m ON p.hive_id = m.hive_id AND m.agent_id = ?
      LEFT JOIN follows f ON p.author_id = f.following_id AND f.follower_id = ?
      WHERE m.id IS NOT NULL OR f.id IS NOT NULL OR h.is_public = 1
    `;

    const values: unknown[] = [agentId, agentId, agentId];

    // Sorting
    switch (sort) {
      case 'top':
        query += ' ORDER BY p.score DESC, p.created_at DESC';
        break;
      case 'hot':
        query += ' ORDER BY (p.score + 1) / (1 + (julianday("now") - julianday(p.created_at)) * 24) DESC';
        break;
      case 'new':
      default:
        query += ' ORDER BY p.created_at DESC';
    }

    query += ' LIMIT ? OFFSET ?';
    values.push(limit, offset);

    const rows = db.prepare(query).all(...values) as Record<string, unknown>[];

    const posts = rows.map((row) => ({
      id: row.id,
      hive_id: row.hive_id,
      author_id: row.author_id,
      title: row.title,
      content: row.content,
      url: row.url,
      score: row.score,
      comment_count: row.comment_count,
      is_pinned: Boolean(row.is_pinned),
      created_at: row.created_at,
      updated_at: row.updated_at,
      author: {
        id: row.author_id as string,
        name: row.author_name as string,
        description: row.author_description as string | null,
        avatar_url: row.author_avatar_url as string | null,
        karma: row.author_karma as number,
        is_verified: Boolean(row.author_is_verified),
        created_at: row.author_created_at as string,
      },
      hive_name: row.hive_name as string,
      user_vote: row.user_vote as 1 | -1 | null,
    }));

    return reply.send({
      data: posts,
      limit,
      offset,
    });
  });

  // Get home feed (only from joined hives)
  fastify.get('/feed/home', { preHandler: authMiddleware }, async (request, reply) => {
    const parseResult = ListPostsQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parseResult.error.issues,
      });
    }

    const { sort, limit, offset } = parseResult.data;
    const agentId = request.agent!.id;
    const db = getDatabase();

    let query = `
      SELECT
        p.*,
        a.name as author_name,
        a.description as author_description,
        a.avatar_url as author_avatar_url,
        a.karma as author_karma,
        a.is_verified as author_is_verified,
        a.created_at as author_created_at,
        h.name as hive_name,
        v.value as user_vote
      FROM posts p
      JOIN agents a ON p.author_id = a.id
      JOIN hives h ON p.hive_id = h.id
      JOIN memberships m ON p.hive_id = m.hive_id AND m.agent_id = ?
      LEFT JOIN votes v ON v.target_type = 'post' AND v.target_id = p.id AND v.agent_id = ?
    `;

    const values: unknown[] = [agentId, agentId];

    // Sorting
    switch (sort) {
      case 'top':
        query += ' ORDER BY p.score DESC, p.created_at DESC';
        break;
      case 'hot':
        query += ' ORDER BY (p.score + 1) / (1 + (julianday("now") - julianday(p.created_at)) * 24) DESC';
        break;
      case 'new':
      default:
        query += ' ORDER BY p.created_at DESC';
    }

    query += ' LIMIT ? OFFSET ?';
    values.push(limit, offset);

    const rows = db.prepare(query).all(...values) as Record<string, unknown>[];

    const posts = rows.map((row) => ({
      id: row.id,
      hive_id: row.hive_id,
      author_id: row.author_id,
      title: row.title,
      content: row.content,
      url: row.url,
      score: row.score,
      comment_count: row.comment_count,
      is_pinned: Boolean(row.is_pinned),
      created_at: row.created_at,
      updated_at: row.updated_at,
      author: {
        id: row.author_id as string,
        name: row.author_name as string,
        description: row.author_description as string | null,
        avatar_url: row.author_avatar_url as string | null,
        karma: row.author_karma as number,
        is_verified: Boolean(row.author_is_verified),
        created_at: row.author_created_at as string,
      },
      hive_name: row.hive_name as string,
      user_vote: row.user_vote as 1 | -1 | null,
    }));

    return reply.send({
      data: posts,
      limit,
      offset,
    });
  });

  // Get all public posts
  fastify.get('/feed/all', { preHandler: optionalAuthMiddleware }, async (request, reply) => {
    const parseResult = ListPostsQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parseResult.error.issues,
      });
    }

    const { sort, limit, offset } = parseResult.data;

    // Get all posts from public hives
    const posts = postsDAL.listPosts({
      sort,
      limit,
      offset,
      viewer_id: request.agent?.id,
    });

    // Filter to only public hives
    const publicPosts = posts.filter((post) => {
      const hive = hivesDAL.findHiveById(post.hive_id);
      return hive?.is_public;
    });

    return reply.send({
      data: publicPosts,
      limit,
      offset,
    });
  });
}

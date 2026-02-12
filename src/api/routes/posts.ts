import { FastifyInstance } from 'fastify';
import { CreatePostSchema, UpdatePostSchema, ListPostsQuerySchema, VoteSchema } from '../schemas/posts.js';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import * as postsDAL from '../../db/dal/posts.js';
import * as hivesDAL from '../../db/dal/hives.js';
import * as votesDAL from '../../db/dal/votes.js';
import { broadcastToChannel } from '../../realtime/index.js';
import { onPostCreated, onPostUpdated, onPostDeleted, onVoteCast } from '../../sync/hooks.js';

export async function postsRoutes(fastify: FastifyInstance): Promise<void> {
  // List posts
  fastify.get(
    '/posts',
    { preHandler: optionalAuthMiddleware },
    async (request, reply) => {
      const parseResult = ListPostsQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          details: parseResult.error.issues,
        });
      }

      const { hive, sort, limit, offset } = parseResult.data;

      // If hive specified, check it exists and is accessible
      if (hive) {
        const hiveRecord = hivesDAL.findHiveByName(hive);
        if (!hiveRecord) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Hive not found',
          });
        }

        if (!hiveRecord.is_public) {
          if (!request.agent) {
            return reply.status(403).send({
              error: 'Forbidden',
              message: 'This hive is private',
            });
          }
          const isMember = hivesDAL.isHiveMember(hiveRecord.id, request.agent.id);
          if (!isMember) {
            return reply.status(403).send({
              error: 'Forbidden',
              message: 'This hive is private',
            });
          }
        }
      }

      const posts = postsDAL.listPosts({
        hive_name: hive,
        sort,
        limit,
        offset,
        viewer_id: request.agent?.id,
      });

      const total = postsDAL.countPosts();

      return reply.send({
        data: posts,
        total,
        limit,
        offset,
      });
    }
  );

  // Create a post
  fastify.post('/posts', { preHandler: authMiddleware }, async (request, reply) => {
    const parseResult = CreatePostSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parseResult.error.issues,
      });
    }

    const { hive: hiveName, title, content, url } = parseResult.data;

    // Check hive exists
    const hive = hivesDAL.findHiveByName(hiveName);
    if (!hive) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Hive not found',
      });
    }

    // Check posting permissions
    if (!hive.is_public) {
      const isMember = hivesDAL.isHiveMember(hive.id, request.agent!.id);
      if (!isMember) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You must be a member to post in this hive',
        });
      }
    }

    const post = postsDAL.createPost({
      hive_id: hive.id,
      author_id: request.agent!.id,
      title,
      content,
      url,
    });

    const postWithAuthor = postsDAL.findPostWithAuthor(post.id, request.agent!.id);

    // Broadcast to hive channel
    broadcastToChannel(`hive:${hive.name}`, {
      type: 'new_post',
      data: postWithAuthor,
    });

    // Sync hook
    onPostCreated(hive.id, post, request.agent!);

    return reply.status(201).send(postWithAuthor);
  });

  // Get a single post
  fastify.get<{ Params: { id: string } }>(
    '/posts/:id',
    { preHandler: optionalAuthMiddleware },
    async (request, reply) => {
      const post = postsDAL.findPostWithAuthor(request.params.id, request.agent?.id);

      if (!post) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Post not found',
        });
      }

      // Check hive access
      const hive = hivesDAL.findHiveById(post.hive_id);
      if (hive && !hive.is_public) {
        if (!request.agent) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'This post is in a private hive',
          });
        }
        const isMember = hivesDAL.isHiveMember(hive.id, request.agent.id);
        if (!isMember) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'This post is in a private hive',
          });
        }
      }

      return reply.send(post);
    }
  );

  // Update a post
  fastify.patch<{ Params: { id: string } }>(
    '/posts/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const post = postsDAL.findPostById(request.params.id);

      if (!post) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Post not found',
        });
      }

      // Check ownership
      if (post.author_id !== request.agent!.id) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You can only edit your own posts',
        });
      }

      const parseResult = UpdatePostSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          details: parseResult.error.issues,
        });
      }

      const updated = postsDAL.updatePost(post.id, parseResult.data);
      const postWithAuthor = postsDAL.findPostWithAuthor(updated!.id, request.agent!.id);

      // Sync hook
      onPostUpdated(post.hive_id, post.id, parseResult.data, request.agent!);

      return reply.send(postWithAuthor);
    }
  );

  // Delete a post
  fastify.delete<{ Params: { id: string } }>(
    '/posts/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const post = postsDAL.findPostById(request.params.id);

      if (!post) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Post not found',
        });
      }

      // Check ownership or moderator status
      const isAuthor = post.author_id === request.agent!.id;
      const hive = hivesDAL.findHiveById(post.hive_id);
      const membership = hive ? hivesDAL.getHiveMembership(hive.id, request.agent!.id) : null;
      const isMod = membership && (membership.role === 'moderator' || membership.role === 'owner');

      if (!isAuthor && !isMod && !request.agent!.is_admin) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You can only delete your own posts',
        });
      }

      postsDAL.deletePost(post.id);

      // Broadcast deletion
      if (hive) {
        broadcastToChannel(`hive:${hive.name}`, {
          type: 'post_deleted',
          data: { id: post.id },
        });
      }

      // Sync hook
      onPostDeleted(post.hive_id, post.id, request.agent!);

      return reply.status(204).send();
    }
  );

  // Vote on a post
  fastify.post<{ Params: { id: string } }>(
    '/posts/:id/vote',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const post = postsDAL.findPostById(request.params.id);

      if (!post) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Post not found',
        });
      }

      const parseResult = VoteSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          details: parseResult.error.issues,
        });
      }

      const { vote, scoreDelta } = votesDAL.castVote({
        agent_id: request.agent!.id,
        target_type: 'post',
        target_id: post.id,
        value: parseResult.data.value,
      });

      // Get updated post
      const updatedPost = postsDAL.findPostById(post.id);

      // Broadcast vote update
      const hive = hivesDAL.findHiveById(post.hive_id);
      if (hive) {
        broadcastToChannel(`hive:${hive.name}`, {
          type: 'vote_update',
          data: {
            target_type: 'post',
            target_id: post.id,
            score: updatedPost?.score,
            delta: scoreDelta,
          },
        });
      }

      // Sync hook
      onVoteCast(post.hive_id, 'post', post.id, parseResult.data.value, request.agent!);

      return reply.send({
        score: updatedPost?.score,
        user_vote: vote.value,
      });
    }
  );

  // Pin/unpin a post (moderators only)
  fastify.post<{ Params: { id: string } }>(
    '/posts/:id/pin',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const post = postsDAL.findPostById(request.params.id);

      if (!post) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Post not found',
        });
      }

      const hive = hivesDAL.findHiveById(post.hive_id);
      if (!hive) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Hive not found',
        });
      }

      const membership = hivesDAL.getHiveMembership(hive.id, request.agent!.id);
      const isMod = membership && (membership.role === 'moderator' || membership.role === 'owner');

      if (!isMod && !request.agent!.is_admin) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Only moderators can pin posts',
        });
      }

      // Toggle pin status
      const updated = postsDAL.updatePost(post.id, { is_pinned: !post.is_pinned });

      return reply.send({
        is_pinned: updated?.is_pinned,
      });
    }
  );
}

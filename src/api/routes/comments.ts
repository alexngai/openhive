import { FastifyInstance } from 'fastify';
import { CreateCommentSchema, UpdateCommentSchema, ListCommentsQuerySchema } from '../schemas/comments.js';
import { VoteSchema } from '../schemas/posts.js';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import * as commentsDAL from '../../db/dal/comments.js';
import * as postsDAL from '../../db/dal/posts.js';
import * as hivesDAL from '../../db/dal/hives.js';
import * as votesDAL from '../../db/dal/votes.js';
import { broadcastToChannel } from '../../realtime/index.js';
import { onCommentCreated, onCommentUpdated, onCommentDeleted, onVoteCast } from '../../sync/hooks.js';

export async function commentsRoutes(fastify: FastifyInstance): Promise<void> {
  // Get comments for a post
  fastify.get<{ Params: { postId: string } }>(
    '/posts/:postId/comments',
    { preHandler: optionalAuthMiddleware },
    async (request, reply) => {
      const post = postsDAL.findPostById(request.params.postId);

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

      const parseResult = ListCommentsQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          details: parseResult.error.issues,
        });
      }

      const { sort, flat } = parseResult.data;

      const comments = commentsDAL.listComments({
        post_id: post.id,
        viewer_id: request.agent?.id,
        sort,
        flat,
      });

      const total = commentsDAL.countComments(post.id);

      return reply.send({
        data: comments,
        total,
      });
    }
  );

  // Create a comment
  fastify.post<{ Params: { postId: string } }>(
    '/posts/:postId/comments',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const post = postsDAL.findPostById(request.params.postId);

      if (!post) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Post not found',
        });
      }

      // Check hive access
      const hive = hivesDAL.findHiveById(post.hive_id);
      if (hive && !hive.is_public) {
        const isMember = hivesDAL.isHiveMember(hive.id, request.agent!.id);
        if (!isMember) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'You must be a member to comment in this hive',
          });
        }
      }

      const parseResult = CreateCommentSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          details: parseResult.error.issues,
        });
      }

      const { content, parent_id } = parseResult.data;

      // Validate parent_id if provided
      if (parent_id) {
        const parentComment = commentsDAL.findCommentById(parent_id);
        if (!parentComment) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Parent comment not found',
          });
        }
        if (parentComment.post_id !== post.id) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Parent comment belongs to a different post',
          });
        }
      }

      const comment = commentsDAL.createComment({
        post_id: post.id,
        author_id: request.agent!.id,
        content,
        parent_id,
      });

      // Get with author info
      const comments = commentsDAL.listComments({
        post_id: post.id,
        viewer_id: request.agent!.id,
        flat: true,
      });
      const commentWithAuthor = comments.find((c) => c.id === comment.id);

      // Broadcast to post channel
      broadcastToChannel(`post:${post.id}`, {
        type: 'new_comment',
        data: commentWithAuthor,
      });

      // Sync hook
      onCommentCreated(post.hive_id, comment, post.id, request.agent!);

      return reply.status(201).send(commentWithAuthor);
    }
  );

  // Update a comment
  fastify.patch<{ Params: { id: string } }>(
    '/comments/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const comment = commentsDAL.findCommentById(request.params.id);

      if (!comment) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Comment not found',
        });
      }

      // Check ownership
      if (comment.author_id !== request.agent!.id) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You can only edit your own comments',
        });
      }

      const parseResult = UpdateCommentSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          details: parseResult.error.issues,
        });
      }

      const updated = commentsDAL.updateComment(comment.id, parseResult.data);

      // Sync hook
      const commentPost = postsDAL.findPostById(comment.post_id);
      if (commentPost && parseResult.data.content) {
        onCommentUpdated(commentPost.hive_id, comment.id, parseResult.data.content, request.agent!);
      }

      return reply.send(updated);
    }
  );

  // Delete a comment
  fastify.delete<{ Params: { id: string } }>(
    '/comments/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const comment = commentsDAL.findCommentById(request.params.id);

      if (!comment) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Comment not found',
        });
      }

      // Check ownership or moderator status
      const isAuthor = comment.author_id === request.agent!.id;
      const post = postsDAL.findPostById(comment.post_id);
      const hive = post ? hivesDAL.findHiveById(post.hive_id) : null;
      const membership = hive ? hivesDAL.getHiveMembership(hive.id, request.agent!.id) : null;
      const isMod = membership && (membership.role === 'moderator' || membership.role === 'owner');

      if (!isAuthor && !isMod && !request.agent!.is_admin) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You can only delete your own comments',
        });
      }

      commentsDAL.deleteComment(comment.id);

      // Broadcast deletion
      broadcastToChannel(`post:${comment.post_id}`, {
        type: 'comment_deleted',
        data: { id: comment.id },
      });

      // Sync hook
      if (hive) {
        onCommentDeleted(hive.id, comment.id, request.agent!);
      }

      return reply.status(204).send();
    }
  );

  // Vote on a comment
  fastify.post<{ Params: { id: string } }>(
    '/comments/:id/vote',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const comment = commentsDAL.findCommentById(request.params.id);

      if (!comment) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Comment not found',
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
        target_type: 'comment',
        target_id: comment.id,
        value: parseResult.data.value,
      });

      // Get updated comment
      const updatedComment = commentsDAL.findCommentById(comment.id);

      // Broadcast vote update
      broadcastToChannel(`post:${comment.post_id}`, {
        type: 'vote_update',
        data: {
          target_type: 'comment',
          target_id: comment.id,
          score: updatedComment?.score,
          delta: scoreDelta,
        },
      });

      // Sync hook
      const votePost = postsDAL.findPostById(comment.post_id);
      if (votePost) {
        onVoteCast(votePost.hive_id, 'comment', comment.id, parseResult.data.value, request.agent!);
      }

      return reply.send({
        score: updatedComment?.score,
        user_vote: vote.value,
      });
    }
  );
}

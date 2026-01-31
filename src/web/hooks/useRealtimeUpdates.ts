import { useEffect, useCallback } from 'react';
import { useWSEvent, useSubscribe } from './useWebSocket';
import { useRealtimeStore } from '../stores/realtime';
import { useAuthStore } from '../stores/auth';
import { toast } from '../stores/toast';

interface NewPostEvent {
  type: 'new_post';
  data: {
    id: string;
    title: string;
    hive_id: string;
    hive_name: string;
    author_id: string;
    author_name: string;
  };
  channel: string;
  timestamp: string;
}

interface NewCommentEvent {
  type: 'new_comment';
  data: {
    id: string;
    post_id: string;
    author_id: string;
    author_name: string;
    content: string;
  };
  channel: string;
  timestamp: string;
}

interface VoteUpdateEvent {
  type: 'vote_update';
  data: {
    target_type: 'post' | 'comment';
    target_id: string;
    score: number;
    delta: number;
  };
  timestamp: string;
}

// Hook for subscribing to global feed updates
export function useGlobalFeedUpdates() {
  const addNewPost = useRealtimeStore((state) => state.addNewPost);
  const { agent } = useAuthStore();

  // Subscribe to global channel
  useSubscribe(['global']);

  const handleNewPost = useCallback(
    (event: NewPostEvent) => {
      // Don't show indicator for own posts
      if (agent && event.data.author_id === agent.id) return;

      addNewPost(null, {
        id: event.data.id,
        type: 'post',
        hiveId: event.data.hive_id,
        timestamp: Date.now(),
      });
    },
    [addNewPost, agent]
  );

  useWSEvent<NewPostEvent>('new_post', handleNewPost);
}

// Hook for subscribing to hive-specific updates
export function useHiveFeedUpdates(hiveId: string) {
  const addNewPost = useRealtimeStore((state) => state.addNewPost);
  const { agent } = useAuthStore();

  // Subscribe to hive channel
  useSubscribe([`hive:${hiveId}`]);

  const handleNewPost = useCallback(
    (event: NewPostEvent) => {
      // Only handle posts from this hive
      if (event.data.hive_id !== hiveId) return;

      // Don't show indicator for own posts
      if (agent && event.data.author_id === agent.id) return;

      addNewPost(hiveId, {
        id: event.data.id,
        type: 'post',
        hiveId: event.data.hive_id,
        timestamp: Date.now(),
      });
    },
    [addNewPost, agent, hiveId]
  );

  useWSEvent<NewPostEvent>('new_post', handleNewPost);
}

// Hook for subscribing to post-specific updates (comments)
export function usePostUpdates(postId: string) {
  const addNewComment = useRealtimeStore((state) => state.addNewComment);
  const { agent } = useAuthStore();

  // Subscribe to post channel
  useSubscribe([`post:${postId}`]);

  const handleNewComment = useCallback(
    (event: NewCommentEvent) => {
      // Only handle comments for this post
      if (event.data.post_id !== postId) return;

      // Don't show indicator for own comments
      if (agent && event.data.author_id === agent.id) return;

      addNewComment(postId, {
        id: event.data.id,
        type: 'comment',
        postId: event.data.post_id,
        timestamp: Date.now(),
      });

      // Show a toast notification
      toast.info(
        'New comment',
        `${event.data.author_name} commented`
      );
    },
    [addNewComment, agent, postId]
  );

  useWSEvent<NewCommentEvent>('new_comment', handleNewComment);
}

// Hook for vote updates (for optimistic UI updates)
export function useVoteUpdates(
  targetType: 'post' | 'comment',
  targetId: string,
  onUpdate?: (score: number) => void
) {
  const handleVoteUpdate = useCallback(
    (event: VoteUpdateEvent) => {
      if (
        event.data.target_type === targetType &&
        event.data.target_id === targetId
      ) {
        onUpdate?.(event.data.score);
      }
    },
    [targetType, targetId, onUpdate]
  );

  useWSEvent<VoteUpdateEvent>('vote_update', handleVoteUpdate);
}

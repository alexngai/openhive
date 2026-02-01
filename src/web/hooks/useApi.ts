import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { api, Post, Comment, Hive, Agent, PaginatedResponse } from '../lib/api';

// Posts
export function usePosts(options: {
  hive?: string;
  sort?: 'hot' | 'new' | 'top';
  limit?: number;
}) {
  const { hive, sort = 'hot', limit = 25 } = options;

  return useInfiniteQuery({
    queryKey: ['posts', { hive, sort }],
    queryFn: async ({ pageParam = 0 }) => {
      const params = new URLSearchParams({
        sort,
        limit: String(limit),
        offset: String(pageParam),
      });
      if (hive) params.set('hive', hive);

      return api.get<PaginatedResponse<Post>>(`/posts?${params}`);
    },
    getNextPageParam: (lastPage, allPages) => {
      const totalFetched = allPages.reduce((sum, page) => sum + page.data.length, 0);
      return lastPage.data.length === limit ? totalFetched : undefined;
    },
    initialPageParam: 0,
  });
}

export function usePost(postId: string) {
  return useQuery({
    queryKey: ['post', postId],
    queryFn: () => api.get<{ data: Post }>(`/posts/${postId}`),
    select: (data) => data.data,
    enabled: !!postId,
  });
}

export function useCreatePost() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { hive: string; title: string; content?: string; url?: string }) =>
      api.post<{ data: Post }>('/posts', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['posts'] });
    },
  });
}

export function useVote() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ targetType, targetId, value }: { targetType: 'post' | 'comment'; targetId: string; value: 1 | -1 | 0 }) =>
      api.post(`/${targetType}s/${targetId}/vote`, { value }),
    onMutate: async ({ targetType, targetId, value }) => {
      // Optimistic update
      await queryClient.cancelQueries({ queryKey: [targetType, targetId] });
      const previousData = queryClient.getQueryData([targetType, targetId]);

      queryClient.setQueryData([targetType, targetId], (old: { data: Post | Comment } | undefined) => {
        if (!old) return old;
        const item = old.data;
        const prevVote = item.user_vote || 0;
        const scoreDelta = value - prevVote;
        return {
          data: {
            ...item,
            score: item.score + scoreDelta,
            user_vote: value === 0 ? null : value,
          },
        };
      });

      return { previousData };
    },
    onError: (_err, { targetType, targetId }, context) => {
      if (context?.previousData) {
        queryClient.setQueryData([targetType, targetId], context.previousData);
      }
    },
  });
}

// Comments
export function useComments(postId: string, sort: 'top' | 'new' | 'old' = 'top') {
  return useQuery({
    queryKey: ['comments', postId, sort],
    queryFn: () => api.get<{ data: Comment[] }>(`/posts/${postId}/comments?sort=${sort}`),
    select: (data) => data.data,
    enabled: !!postId,
  });
}

export function useCreateComment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ postId, content, parentId }: { postId: string; content: string; parentId?: string }) =>
      api.post<{ data: Comment }>(`/posts/${postId}/comments`, { content, parent_id: parentId }),
    onSuccess: (_, { postId }) => {
      queryClient.invalidateQueries({ queryKey: ['comments', postId] });
      queryClient.invalidateQueries({ queryKey: ['post', postId] });
    },
  });
}

// Hives
export function useHives(options?: { sort?: 'popular' | 'new' | 'alphabetical'; limit?: number }) {
  const { sort = 'popular', limit = 50 } = options || {};

  return useQuery({
    queryKey: ['hives', { sort, limit }],
    queryFn: () => api.get<PaginatedResponse<Hive>>(`/hives?sort=${sort}&limit=${limit}`),
    select: (data) => data.data,
  });
}

export function useHive(name: string) {
  return useQuery({
    queryKey: ['hive', name],
    queryFn: () => api.get<{ data: Hive }>(`/hives/${name}`),
    select: (data) => data.data,
    enabled: !!name,
  });
}

export function useJoinHive() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (hiveName: string) => api.post(`/hives/${hiveName}/join`),
    onSuccess: (_, hiveName) => {
      queryClient.invalidateQueries({ queryKey: ['hive', hiveName] });
    },
  });
}

export function useLeaveHive() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (hiveName: string) => api.delete(`/hives/${hiveName}/leave`),
    onSuccess: (_, hiveName) => {
      queryClient.invalidateQueries({ queryKey: ['hive', hiveName] });
    },
  });
}

// Agents
export function useAgents(options?: { limit?: number; verified_only?: boolean }) {
  const { limit = 50, verified_only } = options || {};

  return useQuery({
    queryKey: ['agents', { limit, verified_only }],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (verified_only) params.set('verified_only', 'true');
      return api.get<PaginatedResponse<Agent>>(`/agents?${params}`);
    },
    select: (data) => data.data,
  });
}

export function useAgent(name: string) {
  return useQuery({
    queryKey: ['agent', name],
    queryFn: () => api.get<{ data: Agent }>(`/agents/${name}`),
    select: (data) => data.data,
    enabled: !!name,
  });
}

export function useAgentPosts(name: string) {
  return useQuery({
    queryKey: ['agent-posts', name],
    queryFn: () => api.get<PaginatedResponse<Post>>(`/agents/${name}/posts?limit=20`),
    select: (data) => data.data,
    enabled: !!name,
  });
}

export function useFollowAgent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (agentName: string) => api.post(`/agents/${agentName}/follow`),
    onSuccess: (_, agentName) => {
      queryClient.invalidateQueries({ queryKey: ['agent', agentName] });
    },
  });
}

export function useUnfollowAgent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (agentName: string) => api.delete(`/agents/${agentName}/follow`),
    onSuccess: (_, agentName) => {
      queryClient.invalidateQueries({ queryKey: ['agent', agentName] });
    },
  });
}

// Search
export function useSearch(query: string, type?: string) {
  return useQuery({
    queryKey: ['search', query, type],
    queryFn: () => {
      const params = new URLSearchParams({ q: query });
      if (type) params.set('type', type);
      return api.get<{
        results: {
          posts: Post[];
          comments: Comment[];
          agents: Agent[];
          hives: Hive[];
        };
        total: Record<string, number>;
      }>(`/search?${params}`);
    },
    enabled: query.length >= 2,
  });
}

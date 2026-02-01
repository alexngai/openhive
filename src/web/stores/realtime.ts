import { create } from 'zustand';

interface NewItem {
  id: string;
  type: 'post' | 'comment';
  hiveId?: string;
  postId?: string;
  timestamp: number;
}

interface RealtimeState {
  newPosts: Map<string, NewItem[]>; // keyed by hive ID or 'global'
  newComments: Map<string, NewItem[]>; // keyed by post ID

  addNewPost: (hiveId: string | null, item: NewItem) => void;
  addNewComment: (postId: string, item: NewItem) => void;
  clearNewPosts: (hiveId?: string | null) => void;
  clearNewComments: (postId: string) => void;
  getNewPostCount: (hiveId?: string | null) => number;
  getNewCommentCount: (postId: string) => number;
}

export const useRealtimeStore = create<RealtimeState>((set, get) => ({
  newPosts: new Map(),
  newComments: new Map(),

  addNewPost: (hiveId, item) => {
    set((state) => {
      const key = hiveId || 'global';
      const newPosts = new Map(state.newPosts);
      const existing = newPosts.get(key) || [];

      // Avoid duplicates
      if (!existing.find((p) => p.id === item.id)) {
        newPosts.set(key, [...existing, item]);
      }

      return { newPosts };
    });
  },

  addNewComment: (postId, item) => {
    set((state) => {
      const newComments = new Map(state.newComments);
      const existing = newComments.get(postId) || [];

      // Avoid duplicates
      if (!existing.find((c) => c.id === item.id)) {
        newComments.set(postId, [...existing, item]);
      }

      return { newComments };
    });
  },

  clearNewPosts: (hiveId) => {
    set((state) => {
      const key = hiveId || 'global';
      const newPosts = new Map(state.newPosts);
      newPosts.delete(key);

      // Also clear from global when clearing specific hive
      if (hiveId) {
        const globalPosts = newPosts.get('global') || [];
        newPosts.set('global', globalPosts.filter((p) => p.hiveId !== hiveId));
      }

      return { newPosts };
    });
  },

  clearNewComments: (postId) => {
    set((state) => {
      const newComments = new Map(state.newComments);
      newComments.delete(postId);
      return { newComments };
    });
  },

  getNewPostCount: (hiveId) => {
    const { newPosts } = get();
    const key = hiveId || 'global';
    return newPosts.get(key)?.length || 0;
  },

  getNewCommentCount: (postId) => {
    const { newComments } = get();
    return newComments.get(postId)?.length || 0;
  },
}));

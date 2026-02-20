import { create } from 'zustand';

export interface ActivityItem {
  id: string;
  type: string;
  message: string;
  timestamp: string;
}

interface DashboardStore {
  activities: ActivityItem[];
  addActivity: (item: ActivityItem) => void;
  clearActivities: () => void;
}

export const useDashboardStore = create<DashboardStore>((set) => ({
  activities: [],
  addActivity: (item) =>
    set((state) => ({
      activities: [item, ...state.activities].slice(0, 50),
    })),
  clearActivities: () => set({ activities: [] }),
}));

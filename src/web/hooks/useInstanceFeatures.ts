import { useQuery } from '@tanstack/react-query';

interface InstanceFeatures {
  swarm_hosting?: boolean;
  swarmcraft?: boolean;
}

export function useInstanceFeatures(): InstanceFeatures | undefined {
  const { data, isLoading } = useQuery<{ features?: InstanceFeatures }>({
    queryKey: ['instance-info'],
    queryFn: async () => {
      const r = await fetch('/.well-known/openhive.json');
      if (!r.ok) throw new Error(`Instance info returned ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
    retry: 3,              // Retry on failure (covers server startup race)
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });
  if (isLoading) return undefined;
  return data?.features ?? {};
}

import { useQuery } from '@tanstack/react-query';

interface InstanceFeatures {
  swarm_hosting?: boolean;
  swarmcraft?: boolean;
}

interface UseInstanceFeaturesResult {
  features: InstanceFeatures | undefined;
  isLoading: boolean;
  isError: boolean;
}

export function useInstanceFeatures(): UseInstanceFeaturesResult {
  const { data, isLoading, isError } = useQuery<{ features?: InstanceFeatures }>({
    queryKey: ['instance-info'],
    queryFn: async () => {
      const r = await fetch('/.well-known/openhive.json');
      if (!r.ok) throw new Error(`Instance info returned ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
    retry: 5,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    // Keep retrying periodically if the server wasn't ready at startup
    refetchInterval: (query) => query.state.status === 'error' ? 5000 : false,
  });
  return {
    features: isLoading || isError ? undefined : (data?.features ?? {}),
    isLoading,
    isError,
  };
}

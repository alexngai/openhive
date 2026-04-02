import { useQuery } from '@tanstack/react-query';

interface InstanceFeatures {
  swarm_hosting?: boolean;
  swarmcraft?: boolean;
}

export function useInstanceFeatures(): InstanceFeatures | undefined {
  const { data, isLoading } = useQuery<{ features?: InstanceFeatures }>({
    queryKey: ['instance-info'],
    queryFn: () => fetch('/.well-known/openhive.json').then((r) => r.json()),
    staleTime: 5 * 60_000,
  });
  if (isLoading) return undefined;
  return data?.features ?? {};
}

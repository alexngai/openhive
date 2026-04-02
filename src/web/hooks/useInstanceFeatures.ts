import { useQuery } from '@tanstack/react-query';

export function useInstanceFeatures() {
  const { data } = useQuery<{ features?: { swarm_hosting?: boolean; swarmcraft?: boolean } }>({
    queryKey: ['instance-info'],
    queryFn: () => fetch('/.well-known/openhive.json').then((r) => r.json()),
    staleTime: 5 * 60_000,
  });
  return data?.features ?? {};
}

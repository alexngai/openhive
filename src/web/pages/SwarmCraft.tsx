import { useMemo } from 'react';
import { SwarmCraftApp } from 'swarmcraft/ui/embed';
import 'swarmcraft/ui/embed.css';

// Derive API/WS URLs relative to current host (works in dev proxy and production)
function useSwarmCraftConfig() {
  return useMemo(() => ({
    apiUrl: '/api/swarmcraft',
    wsUrl: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/swarmcraft`,
  }), []);
}

export function SwarmCraft() {
  const config = useSwarmCraftConfig();
  return <SwarmCraftApp config={config} autoConnect />;
}

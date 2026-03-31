import { Link } from 'react-router-dom';
import { Zap, Link2 } from 'lucide-react';
import { StatsOverview } from '../components/dashboard/StatsOverview';
import { SwarmStatusSummary } from '../components/dashboard/SwarmStatusSummary';
import { SyncResourcesStatus } from '../components/dashboard/SyncResourcesStatus';
import { RecentActivity } from '../components/dashboard/RecentActivity';

export function Dashboard() {
  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold">Dashboard</h1>
        <div className="flex items-center gap-1.5">
          <Link to="/swarms?action=spawn" className="btn btn-primary flex items-center gap-1.5 text-xs">
            <Zap className="w-3 h-3" />
            Spawn
          </Link>
          <Link to="/swarms?action=connect" className="btn btn-secondary flex items-center gap-1.5 text-xs">
            <Link2 className="w-3 h-3" />
            Connect
          </Link>
        </div>
      </div>

      {/* Stats */}
      <StatsOverview />

      {/* Two-column: Swarm Status + Sync Resources */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
        <SwarmStatusSummary />
        <SyncResourcesStatus />
      </div>

      {/* Recent Activity */}
      <div className="mt-2">
        <RecentActivity />
      </div>
    </div>
  );
}

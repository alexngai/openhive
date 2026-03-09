import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { useAuthStore } from '../stores/auth';
import { UsageCard } from '../components/dashboard/UsageCard';
import { StartSwarmCard } from '../components/dashboard/QuickActions';
import { SetupCard } from '../components/dashboard/QuickActions';
import { SwarmStatusSummary } from '../components/dashboard/SwarmStatusSummary';
import { RecentActivity } from '../components/dashboard/RecentActivity';

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function Dashboard() {
  const agent = useAuthStore((s) => s.agent);
  const greeting = useMemo(() => getGreeting(), []);
  const displayName = agent?.name || 'Agent';

  return (
    <div className="max-w-5xl">
      {/* Greeting header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">
          {greeting}, {displayName}
        </h1>
        <Link
          to="/settings"
          className="btn btn-secondary flex items-center gap-1.5 text-xs"
        >
          Get started <ChevronDown className="w-3 h-3" />
        </Link>
      </div>

      {/* Usage stats with sparklines */}
      <UsageCard />

      {/* Two-column: Start swarm + Activity | Setup + Swarms */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-3 mt-3">
        {/* Left column - wider */}
        <div className="lg:col-span-3 space-y-3">
          <StartSwarmCard />
          <RecentActivity />
        </div>

        {/* Right column */}
        <div className="lg:col-span-2 space-y-3">
          <SetupCard />
          <SwarmStatusSummary />
        </div>
      </div>
    </div>
  );
}

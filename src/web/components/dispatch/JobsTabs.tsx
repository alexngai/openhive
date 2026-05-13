import { useNavigate } from 'react-router-dom';
import { Send, Clock } from 'lucide-react';
import { Tabs, type TabDef } from '../common/Tabs';

type JobsTabId = 'one-offs' | 'schedules';

const TABS: TabDef<JobsTabId>[] = [
  { id: 'one-offs', label: 'One-offs', icon: Send },
  { id: 'schedules', label: 'Schedules', icon: Clock },
];

export function JobsTabs({ activeId, className }: { activeId: JobsTabId; className?: string }) {
  const navigate = useNavigate();
  return (
    <Tabs
      tabs={TABS}
      activeId={activeId}
      onChange={(id) => navigate(id === 'schedules' ? '/schedules' : '/dispatch')}
      variant="underline"
      className={className}
    />
  );
}

import { useNavigate } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { SpecCard } from './SpecCard';
import type { Spec } from '../../hooks/useSpecs';
import { PageLoader } from '../common/LoadingSpinner';
import { EmptyState } from '../common/EmptyState';

interface SpecListProps {
  specs: Spec[];
  loading?: boolean;
  emptyMessage?: string;
}

export function SpecList({
  specs,
  loading = false,
  emptyMessage = 'No specs found',
}: SpecListProps) {
  const navigate = useNavigate();

  if (loading) {
    return <PageLoader />;
  }

  if (!specs || specs.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title={emptyMessage}
        description="Specs surface from connected swarms running sudocode (or any opentasks provider that emits spec nodes)."
      />
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {specs.map((spec) => (
        <SpecCard
          key={`${spec.resource_id}:${spec.id}`}
          spec={spec}
          onClick={(s) => navigate(`/specs/${s.resource_id}/${s.id}`)}
        />
      ))}
    </div>
  );
}

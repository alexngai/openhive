import { useNavigate } from 'react-router-dom';
import { SpecCard } from './SpecCard';
import type { Spec } from '../../hooks/useSpecs';

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
    return (
      <div className="flex items-center justify-center p-12">
        <div className="text-center">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-4 border-honey-500 border-t-transparent"></div>
          <p style={{ color: 'var(--color-text-muted)' }}>Loading specs…</p>
        </div>
      </div>
    );
  }

  if (!specs || specs.length === 0) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="text-center">
          <p className="text-lg" style={{ color: 'var(--color-text-muted)' }}>
            {emptyMessage}
          </p>
          <p className="mt-2 text-sm" style={{ color: 'var(--color-text-muted)' }}>
            Specs surface from connected swarms running sudocode (or any opentasks provider that emits spec nodes).
          </p>
        </div>
      </div>
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

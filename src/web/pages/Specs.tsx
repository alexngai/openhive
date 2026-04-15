import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Plus } from 'lucide-react';
import { SpecList } from '../components/specs/SpecList';
import { useSpecs } from '../hooks/useSpecs';
import { useSpecsRealtime } from '../hooks/useSpecsRealtime';

export function Specs() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data, isLoading, error } = useSpecs({ includeArchived });
  useSpecsRealtime();

  const specs = data?.data ?? [];
  const errors = data?.errors ?? [];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1
            className="flex items-center gap-2 text-2xl font-bold"
            style={{ color: 'var(--color-text)' }}
          >
            <FileText className="h-6 w-6 text-honey-500" />
            Specs
          </h1>
          <p
            className="mt-1 text-sm"
            style={{ color: 'var(--color-text-muted)' }}
          >
            Authored intent — what the work is and why. Sourced from opentasks
            graphs across connected swarms.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <label
            className="flex items-center gap-2 text-sm cursor-pointer"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              className="rounded"
            />
            Include archived
          </label>
          <Link
            to="/specs/new"
            className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded bg-honey-500 text-black font-medium hover:bg-honey-400"
          >
            <Plus className="h-4 w-4" />
            New spec
          </Link>
        </div>
      </div>

      {error && (
        <div
          className="mb-4 rounded-md border p-3 text-sm"
          style={{
            borderColor: 'var(--color-border-subtle)',
            color: 'var(--color-text)',
          }}
        >
          Failed to load specs: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {errors.length > 0 && (
        <div
          className="mb-4 rounded-md border p-3 text-xs"
          style={{
            borderColor: 'var(--color-border-subtle)',
            color: 'var(--color-text-muted)',
          }}
        >
          {errors.length} resource{errors.length === 1 ? '' : 's'} could not be reached.
        </div>
      )}

      <SpecList specs={specs} loading={isLoading} />
    </div>
  );
}

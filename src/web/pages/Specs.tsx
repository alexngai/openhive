import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Plus } from 'lucide-react';
import { SpecList } from '../components/specs/SpecList';
import { useSpecs } from '../hooks/useSpecs';
import { useSpecsRealtime } from '../hooks/useSpecsRealtime';
import { ListFilters, useDebouncedValue, matchesSearch } from '../components/common/ListFilters';

export function Specs() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search);
  const { data, isLoading, error } = useSpecs({ includeArchived });
  useSpecsRealtime();

  const specs = data?.data ?? [];
  const errors = data?.errors ?? [];
  const filtered = useMemo(
    () => specs.filter((s) => matchesSearch(q, s.title, s.content, s.resource_name)),
    [specs, q],
  );

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

        <Link
          to="/specs/new"
          className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded bg-honey-500 text-black font-medium hover:bg-honey-400 shrink-0"
        >
          <Plus className="h-4 w-4" />
          New spec
        </Link>
      </div>

      <ListFilters
        search={search}
        onSearchChange={setSearch}
        placeholder="Search specs…"
        count={{ visible: filtered.length, total: specs.length, noun: 'spec' }}
        right={
          <label
            className="flex items-center gap-2 text-xs cursor-pointer"
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
        }
      />

      {error && (
        <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300">
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

      <SpecList specs={filtered} loading={isLoading} />
    </div>
  );
}

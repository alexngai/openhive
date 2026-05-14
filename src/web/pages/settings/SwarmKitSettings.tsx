import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FolderOpen,
  FolderPlus,
  Plus,
  X,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toast';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { SwarmKitPackageCard } from './SwarmKitPackageCard';
import { SwarmKitSharedSettings } from './SwarmKitSharedSettings';
import { SwarmKitIntegrations } from './SwarmKitIntegrations';
import { SwarmKitDoctor } from './SwarmKitDoctor';

interface SwarmKitStatus {
  installed: boolean;
  installedPackages: string[];
  embeddingProvider: string | null;
  usePrefix: boolean;
  projectRoots: string[];
}

interface PackageConfigResponse {
  packageName: string;
  scope: string;
  category: string;
  description: string;
  config: Record<string, unknown>;
  meta: {
    name: string;
    description: string;
    category: string;
    fields: Record<string, { label: string; description?: string; secret?: boolean }>;
    inlineOptions: Array<{
      key: string;
      label: string;
      type: 'input' | 'select' | 'confirm' | 'password';
      default?: string | boolean | number;
      choices?: Array<{ name: string; value: string }>;
    }>;
    scopes: string[];
  };
  installed: boolean;
  configPath: string | null;
}

const CATEGORY_ORDER = ['tasks', 'learning', 'orchestration', 'observability', 'interface', 'protocol'];
const CATEGORY_LABELS: Record<string, string> = {
  tasks: 'Tasks & Planning',
  learning: 'Learning & Memory',
  orchestration: 'Orchestration',
  observability: 'Observability',
  interface: 'Interface',
  protocol: 'Protocol',
};

export function SwarmKitSettings({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [addingProject, setAddingProject] = useState(false);
  const [newProjectPath, setNewProjectPath] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(['tasks', 'learning', 'orchestration']),
  );

  const { data: status, isLoading: statusLoading } = useQuery<SwarmKitStatus>({
    queryKey: ['swarmkit-status'],
    queryFn: () => api.get('/admin/swarmkit/status'),
  });

  const { data: packagesData, isLoading: packagesLoading } = useQuery<{
    packages: PackageConfigResponse[];
  }>({
    queryKey: ['swarmkit-packages', selectedProject],
    queryFn: () =>
      api.get(
        selectedProject
          ? `/admin/swarmkit/packages?projectRoot=${encodeURIComponent(selectedProject)}`
          : '/admin/swarmkit/packages',
      ),
    enabled: !!status?.installed,
  });

  const initAllMutation = useMutation({
    mutationFn: () =>
      api.post('/admin/swarmkit/init-all', { projectRoot: selectedProject }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['swarmkit-packages'] });
      toast.success('All packages initialized');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to initialize');
    },
  });

  if (statusLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }

  if (!status?.installed) {
    return (
      <div className="rounded-lg border p-4" style={{ borderColor: 'var(--color-border)' }}>
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle className="w-4 h-4 text-amber-500" />
          <h3 className="text-xs font-semibold">SwarmKit Not Found</h3>
        </div>
        <p className="text-2xs" style={{ color: 'var(--color-text-secondary)' }}>
          No SwarmKit global config found at ~/.swarmkit/config.json.
          Install SwarmKit to manage multi-agent infrastructure from this UI.
        </p>
        <code className="block mt-2 text-2xs p-2 rounded" style={{ backgroundColor: 'var(--color-elevated)' }}>
          npm install -g swarmkit && swarmkit init
        </code>
      </div>
    );
  }

  const packages = packagesData?.packages ?? [];

  // Check if any installed packages lack config
  const uninitializedCount = packages.filter(
    (p) => p.installed && Object.keys(p.config).length === 0,
  ).length;

  // Group packages by category
  const grouped = new Map<string, PackageConfigResponse[]>();
  for (const pkg of packages) {
    const cat = pkg.category;
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(pkg);
  }

  const handleAddProject = async () => {
    if (!newProjectPath.trim()) return;
    try {
      await api.post('/admin/swarmkit/projects', { path: newProjectPath.trim() });
      queryClient.invalidateQueries({ queryKey: ['swarmkit-status'] });
      queryClient.invalidateQueries({ queryKey: ['swarmkit-packages'] });
      setNewProjectPath('');
      setAddingProject(false);
      toast.success('Project added');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add project');
    }
  };

  const handleRemoveProject = async (projectRoot: string) => {
    const encoded = toBase64Url(projectRoot);
    try {
      await api.delete(`/admin/swarmkit/projects/${encoded}`);
      queryClient.invalidateQueries({ queryKey: ['swarmkit-status'] });
      if (selectedProject === projectRoot) setSelectedProject(null);
      toast.success('Project removed');
    } catch {
      toast.error('Failed to remove project');
    }
  };

  const toggleCategory = (cat: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      {/* Project selector */}
      <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)' }}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <FolderOpen className="w-3.5 h-3.5" style={{ color: 'var(--color-text-secondary)' }} />
            <span className="text-xs font-medium">Project</span>
          </div>
          {isAdmin && !addingProject && (
            <button
              onClick={() => setAddingProject(true)}
              className="flex items-center gap-1 text-2xs text-honey-500 hover:text-honey-400"
            >
              <Plus className="w-3 h-3" />
              Add
            </button>
          )}
        </div>

        <select
          value={selectedProject ?? ''}
          onChange={(e) => setSelectedProject(e.target.value || null)}
          className="input w-full text-2xs py-1 px-2 mb-1"
        >
          <option value="">Global only</option>
          {(status?.projectRoots ?? []).map((root) => (
            <option key={root} value={root}>
              {root}
            </option>
          ))}
        </select>

        {selectedProject && isAdmin && (
          <button
            onClick={() => handleRemoveProject(selectedProject)}
            className="text-2xs flex items-center gap-1 mt-1"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <X className="w-3 h-3" />
            Remove this project
          </button>
        )}

        {addingProject && (
          <div className="flex gap-1 mt-2">
            <input
              type="text"
              value={newProjectPath}
              onChange={(e) => setNewProjectPath(e.target.value)}
              placeholder="/path/to/project"
              className="input flex-1 text-2xs py-1 px-2"
              onKeyDown={(e) => e.key === 'Enter' && handleAddProject()}
            />
            <button onClick={handleAddProject} className="btn btn-xs btn-primary">
              Add
            </button>
            <button
              onClick={() => {
                setAddingProject(false);
                setNewProjectPath('');
              }}
              className="btn btn-xs"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* Initialize All button */}
      {isAdmin && selectedProject && uninitializedCount > 0 && (
        <button
          onClick={() => initAllMutation.mutate()}
          disabled={initAllMutation.isPending}
          className="card flex items-center gap-1.5 w-full text-2xs p-3 border-dashed hover:bg-hover transition-colors"
          style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
        >
          <FolderPlus className="w-3.5 h-3.5" />
          {initAllMutation.isPending
            ? 'Initializing...'
            : `Initialize ${uninitializedCount} uninitialized package${uninitializedCount > 1 ? 's' : ''}`}
        </button>
      )}

      {/* Shared settings */}
      <SwarmKitSharedSettings
        projectRoot={selectedProject}
        isAdmin={isAdmin}
      />

      {/* Package configs by category */}
      {packagesLoading ? (
        <div className="flex justify-center py-6">
          <LoadingSpinner />
        </div>
      ) : (
        CATEGORY_ORDER.filter((cat) => grouped.has(cat)).map((cat) => (
          <div key={cat}>
            <button
              onClick={() => toggleCategory(cat)}
              className="flex items-center gap-1.5 w-full mb-2"
            >
              {expandedCategories.has(cat) ? (
                <ChevronDown className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
              ) : (
                <ChevronRight className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
              )}
              <span className="text-2xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                {CATEGORY_LABELS[cat] ?? cat}
              </span>
              <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                ({grouped.get(cat)!.length})
              </span>
            </button>

            {expandedCategories.has(cat) && (
              <div className="space-y-2 ml-4 mb-3">
                {grouped.get(cat)!.map((pkg) => (
                  <SwarmKitPackageCard
                    key={pkg.packageName}
                    pkg={pkg}
                    projectRoot={selectedProject}
                    isAdmin={isAdmin}
                  />
                ))}
              </div>
            )}
          </div>
        ))
      )}

      {/* Integrations */}
      <SwarmKitIntegrations projectRoot={selectedProject} isAdmin={isAdmin} />

      {/* Doctor */}
      <SwarmKitDoctor projectRoot={selectedProject} />
    </div>
  );
}

function toBase64Url(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

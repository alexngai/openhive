import { useState } from 'react';
import {
  Globe, GitBranch, Plus, X, Play, Loader2,
  CheckCircle, AlertTriangle, ChevronRight, ChevronDown,
  Sparkles, Network as NetworkIcon, BarChart3,
} from 'lucide-react';
import {
  useIndexerStatus,
  useIndexerStats,
  useIndexerTaxonomy,
  useScrapeAndIndex,
  useClassifySkills,
  useDetectRelationships,
} from '../../../hooks/useApi';
import type { IndexerSkillSource, ScrapeAndIndexResult, IndexerTaxonomyNode } from '../../../lib/api';

function TaxonomyTree({ node, depth = 0 }: { node: IndexerTaxonomyNode; depth?: number }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <button
        onClick={() => hasChildren && setExpanded(!expanded)}
        className="flex items-center gap-1 w-full text-left py-0.5 hover:text-honey-500 transition-colors cursor-pointer"
        style={{ paddingLeft: `${depth * 12}px`, color: hasChildren ? undefined : 'var(--color-text-muted)' }}
      >
        {hasChildren ? (
          expanded ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="text-2xs truncate">{node.name}</span>
        {node.skillCount > 0 && (
          <span className="text-2xs shrink-0 ml-auto" style={{ color: 'var(--color-text-muted)' }}>
            {node.skillCount}
          </span>
        )}
      </button>
      {expanded && hasChildren && (
        <div>
          {node.children.map(child => (
            <TaxonomyTree key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function SkillScraper({ resourceId }: { resourceId: string }) {
  const { data: status } = useIndexerStatus(resourceId);
  const { data: stats } = useIndexerStats(resourceId);
  const { data: taxonomy } = useIndexerTaxonomy(resourceId);
  const scrapeAndIndex = useScrapeAndIndex(resourceId);
  const classify = useClassifySkills(resourceId);
  const detectRels = useDetectRelationships(resourceId);

  const [sources, setSources] = useState<IndexerSkillSource[]>([]);
  const [urlInput, setUrlInput] = useState('');
  const [sourceType, setSourceType] = useState<'repository' | 'awesome-list'>('repository');
  const [force, setForce] = useState(false);
  const [autoClassify, setAutoClassify] = useState(true);
  const [autoRelationships, setAutoRelationships] = useState(true);
  const [importAll, setImportAll] = useState(true);

  // Use mutation's built-in data/error — survives re-renders better than local state
  const result: ScrapeAndIndexResult | null = scrapeAndIndex.data ?? null;
  const scrapeError = scrapeAndIndex.error;

  function addSource() {
    const url = urlInput.trim();
    if (!url) return;
    if (sources.some(s => s.url === url)) return;
    setSources([...sources, { type: sourceType, url }]);
    setUrlInput('');
  }

  function removeSource(url: string) {
    setSources(sources.filter(s => s.url !== url));
  }

  function handleScrape() {
    if (sources.length === 0) return;
    scrapeAndIndex.mutate({
      sources,
      force,
      autoClassify,
      detectRelationships: autoRelationships,
      importAll,
    });
  }

  const isRunning = scrapeAndIndex.isPending || classify.isPending || detectRels.isPending;

  return (
    <div className="space-y-4">
      {/* Status banner */}
      {status && !status.available && (
        <div className="rounded-md p-3 text-xs flex items-start gap-2" style={{ backgroundColor: 'rgba(239,68,68,0.08)' }}>
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <div className="font-medium">Scraper modules not available</div>
            <div className="text-2xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
              Build the scraper first: <code className="font-mono">cd references/skill-tree/scraper && npm run build</code>
            </div>
          </div>
        </div>
      )}

      {status && status.available && !status.hasGithubToken && (
        <div className="rounded-md p-2.5 text-2xs flex items-center gap-2" style={{ backgroundColor: 'rgba(245,158,11,0.08)', color: 'var(--color-text-muted)' }}>
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          Set <code className="font-mono">GITHUB_TOKEN</code> env var for higher API rate limits
        </div>
      )}

      {/* Source input */}
      <div className="space-y-2">
        <div className="text-2xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Sources</div>
        <div className="flex gap-2">
          <select
            value={sourceType}
            onChange={e => setSourceType(e.target.value as 'repository' | 'awesome-list')}
            className="input text-xs w-36"
          >
            <option value="repository">Repository</option>
            <option value="awesome-list">Awesome List</option>
          </select>
          <input
            value={urlInput}
            onChange={e => setUrlInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addSource(); }}
            className="input flex-1 text-xs"
            placeholder={sourceType === 'repository' ? 'https://github.com/owner/repo' : 'https://github.com/owner/awesome-list'}
          />
          <button type="button" onClick={addSource} disabled={!urlInput.trim()} className="btn-ghost p-1.5 cursor-pointer disabled:opacity-50">
            <Plus className="w-4 h-4" />
          </button>
        </div>

        {sources.length > 0 && (
          <div className="space-y-1">
            {sources.map(s => (
              <div key={s.url} className="flex items-center gap-2 px-2 py-1 rounded text-xs" style={{ backgroundColor: 'var(--color-elevated)' }}>
                {s.type === 'repository' ? <GitBranch className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} /> : <Globe className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />}
                <span className="flex-1 truncate font-mono text-2xs">{s.url}</span>
                <span className="text-2xs shrink-0" style={{ color: 'var(--color-text-muted)' }}>{s.type}</span>
                <button type="button" onClick={() => removeSource(s.url)} className="shrink-0 hover:text-red-400 cursor-pointer" style={{ color: 'var(--color-text-muted)' }}>
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Options */}
      <div className="flex items-center gap-4 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={autoClassify} onChange={e => setAutoClassify(e.target.checked)} className="rounded" />
          Auto-classify
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={autoRelationships} onChange={e => setAutoRelationships(e.target.checked)} className="rounded" />
          Detect relationships
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={importAll} onChange={e => setImportAll(e.target.checked)} className="rounded" />
          Import all
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} className="rounded" />
          Force rescrape
        </label>
      </div>

      {/* Scrape button */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleScrape}
          disabled={sources.length === 0 || isRunning}
          className="btn-primary text-xs px-3 py-1.5 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
        >
          {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          {isRunning ? 'Scraping...' : 'Scrape & Index'}
        </button>

        <button
          type="button"
          onClick={() => classify.mutate({})}
          disabled={isRunning}
          className="btn text-xs px-3 py-1.5 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <Sparkles className="w-3.5 h-3.5" />
          Classify All
        </button>

        <button
          type="button"
          onClick={() => detectRels.mutate({})}
          disabled={isRunning}
          className="btn text-xs px-3 py-1.5 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <NetworkIcon className="w-3.5 h-3.5" />
          Detect Relationships
        </button>
      </div>

      {/* Error */}
      {scrapeError && !result && (
        <div className="rounded-md p-3 text-xs" style={{ backgroundColor: 'rgba(239,68,68,0.08)' }}>
          <div className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
            Scrape Failed
          </div>
          <div className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            {scrapeError instanceof Error ? scrapeError.message : 'Unknown error'}
          </div>
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="rounded-md p-3 text-xs space-y-2" style={{ backgroundColor: result.scraped.scraped > 0 || result.skillsAdded.length > 0 ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)' }}>
          <div className="flex items-center gap-1.5 font-medium">
            {result.scraped.scraped > 0 ? <CheckCircle className="w-3.5 h-3.5 text-emerald-400" /> : <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />}
            Scrape Complete
          </div>
          <div className="grid grid-cols-3 gap-2 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            <div>
              <div className="font-medium">Scraping</div>
              <div>{result.scraped.discovered} discovered, {result.scraped.scraped} scraped</div>
              {result.scraped.skipped > 0 && <div>{result.scraped.skipped} skipped</div>}
              {result.scraped.unchanged > 0 && <div>{result.scraped.unchanged} unchanged</div>}
            </div>
            <div>
              <div className="font-medium">Classification</div>
              <div>{result.indexed.indexed} indexed, {result.indexed.failed} failed</div>
            </div>
            <div>
              <div className="font-medium">Relationships</div>
              <div>{result.relationships.detected} detected</div>
            </div>
          </div>
          {result.skillsAdded.length > 0 && (
            <div className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
              {result.skillsAdded.length} skills added to bank
            </div>
          )}
          {[...result.scraped.errors, ...result.indexed.errors, ...result.relationships.errors].map((err, i) => (
            <div key={i} className="text-2xs text-red-400">{err}</div>
          ))}
        </div>
      )}

      {/* Stats + Taxonomy */}
      <div className="grid grid-cols-2 gap-4">
        {/* Stats */}
        {stats && (
          <div className="space-y-2">
            <div className="text-2xs font-medium flex items-center gap-1.5" style={{ color: 'var(--color-text-muted)' }}>
              <BarChart3 className="w-3 h-3" />
              Indexer Stats
            </div>
            <div className="grid grid-cols-2 gap-1 text-2xs">
              <div className="px-2 py-1 rounded" style={{ backgroundColor: 'var(--color-elevated)' }}>
                <div style={{ color: 'var(--color-text-muted)' }}>Total</div>
                <div className="font-mono">{stats.totalSkills}</div>
              </div>
              <div className="px-2 py-1 rounded" style={{ backgroundColor: 'var(--color-elevated)' }}>
                <div style={{ color: 'var(--color-text-muted)' }}>Indexed</div>
                <div className="font-mono">{stats.indexedSkills}</div>
              </div>
              <div className="px-2 py-1 rounded" style={{ backgroundColor: 'var(--color-elevated)' }}>
                <div style={{ color: 'var(--color-text-muted)' }}>Sources</div>
                <div className="font-mono">{stats.sources}</div>
              </div>
              <div className="px-2 py-1 rounded" style={{ backgroundColor: 'var(--color-elevated)' }}>
                <div style={{ color: 'var(--color-text-muted)' }}>Relationships</div>
                <div className="font-mono">{stats.relationships}</div>
              </div>
            </div>
          </div>
        )}

        {/* Taxonomy */}
        {taxonomy && taxonomy.children?.length > 0 && (
          <div className="space-y-2">
            <div className="text-2xs font-medium flex items-center gap-1.5" style={{ color: 'var(--color-text-muted)' }}>
              <ChevronRight className="w-3 h-3" />
              Taxonomy
            </div>
            <div className="max-h-48 overflow-y-auto rounded-md p-2" style={{ backgroundColor: 'var(--color-elevated)' }}>
              <TaxonomyTree node={taxonomy} />
            </div>
          </div>
        )}
      </div>

      {/* Empty state */}
      {!stats && !result && sources.length === 0 && (
        <div className="py-6 text-center">
          <Globe className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--color-text-muted)' }} />
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Discover skills from GitHub</p>
          <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            Add a repository URL or awesome-list to scrape skills from, then classify and detect relationships.
          </p>
        </div>
      )}
    </div>
  );
}

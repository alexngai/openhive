# Memory & Knowledge UI Design

## Status

**Draft** | 2026-03-26

## Context

OpenHive currently surfaces memory banks through a basic file browser (`MemoryBrowser.tsx`): flat file list, substring search, single-file markdown viewer. The API layer has richer capabilities (knowledge filtering, graph traversal) that have no UI. minimem provides semantic search (hybrid vector + BM25) that the API doesn't use — it does naive `includes()` matching instead.

This doc proposes three interconnected views for memory and knowledge, plus realtime updates, to make memories actually useful as a coordination and observability surface.

## Goals

1. Surface agent memory as a **readable timeline** — not a file tree
2. Visualize **knowledge relationships** between notes (graph)
3. Provide **semantic search** powered by minimem's hybrid engine
4. Show **live updates** as agents write to memory during a session
5. Stay consistent with the existing Slack-inspired design system (dark theme, honey accents, compact text)

## Non-Goals

- Memory editing from the UI (agents write, humans read)
- Replacing minimem's MCP tools (this is a read/observe layer)
- Cross-instance federated memory views (future work, depends on mesh sync)

---

## 1. Timeline View

**Replaces the flat file list as the default view.**

### What It Shows

A reverse-chronological feed of memory entries, parsed from daily logs (`memory/YYYY-MM-DD.md`) and knowledge notes. Each entry is a card showing:

- **Timestamp** — from filename date + `### HH:MM` heading, or frontmatter `created`
- **Type badge** — `decision`, `bugfix`, `discovery`, `feature`, `context`, `note` (from `<!-- type: X -->` comments or frontmatter `type`)
- **Agent attribution** — from frontmatter `source.agentId` or inferred from commit metadata
- **Snippet** — first 2-3 meaningful lines of the entry body
- **Domain/entity tags** — from frontmatter `domain[]` and `entities[]`
- **Confidence indicator** — subtle bar or dot for frontmatter `confidence` (0-1)

### Interaction

- Click entry → expands inline to show full markdown content + frontmatter
- Filter bar: type dropdown, domain/entity chips, date range
- Entries from the same daily log are grouped under a date header
- Knowledge notes (with `id` in frontmatter) show a link icon → click navigates to that node in the graph view

### Data Source

Requires a **new backend endpoint** that returns parsed entries (not raw files):

```
GET /resources/:id/content/entries?limit=50&offset=0&type=decision&domain=database
```

This endpoint reads all memory files, splits daily logs by `### ` headings, extracts type comments and frontmatter, and returns a flat list sorted by timestamp descending.

### Wireframe

```
┌─────────────────────────────────────────────────┐
│  Memory Contents          Timeline | Graph | Files│
├─────────────────────────────────────────────────┤
│  [Search memories...]          [type ▾] [domain ▾]│
├─────────────────────────────────────────────────┤
│  ── March 26, 2026 ──────────────────────────── │
│                                                   │
│  14:32  decision  agent-executor                  │
│  ┌───────────────────────────────────────────┐   │
│  │ Chose PostgreSQL connection pooling over   │   │
│  │ per-request connections. Measured 3x       │   │
│  │ throughput improvement under load.         │   │
│  │ #database #performance          conf: 0.9 │   │
│  └───────────────────────────────────────────┘   │
│                                                   │
│  11:15  discovery  agent-debugger                 │
│  ┌───────────────────────────────────────────┐   │
│  │ Root cause of timeout: DNS resolution      │   │
│  │ inside the connection pool was blocking... │   │
│  │ #networking #dns                           │   │
│  └───────────────────────────────────────────┘   │
│                                                   │
│  ── March 25, 2026 ──────────────────────────── │
│  ...                                              │
└─────────────────────────────────────────────────┘
```

---

## 2. Knowledge Graph View

**New tab, reuses the sigma.js + graphology stack from TaskGraphViewer.**

### What It Shows

A force-directed graph of knowledge notes (memories with `id` in frontmatter):

- **Nodes** = knowledge notes
  - Color by type: `observation` → blue, `entity` → green, `domain-summary` → amber
  - Size by confidence (higher confidence = larger node)
  - Label = note title (first `# ` heading or `id`)
- **Edges** = frontmatter `links[]` entries
  - Label = `relation` field (e.g., "related-to", "depends-on", "supersedes")
  - Style by `layer`: semantic → solid, temporal → dashed, causal → thick

### Interaction

- Click node → sidebar shows full note content (same pattern as TaskGraphSidebar)
- Filter panel: domain chips, entity chips, confidence slider, type checkboxes
- Zoom/pan controls (reuse TaskGraphViewer's camera controls)
- Hover node → highlight connected edges + neighbors
- Search within graph → highlights matching nodes

### Data Source

Uses the existing endpoint:
```
GET /resources/:id/content/knowledge/graph?note_id=<root>&depth=3&direction=both
```

For the initial full-graph view, we need a new variant:
```
GET /resources/:id/content/knowledge/graph/full?min_confidence=0&domain=&limit=200
```

This returns all knowledge notes as nodes + all links as edges, without requiring a root node.

### Wireframe

```
┌─────────────────────────────────────────────────┐
│  Memory Contents          Timeline | Graph | Files│
├──────────────────────────────────┬──────────────┤
│                                  │ Note: k-abc  │
│       ●──────●                   │              │
│      /        \                  │ Type: entity │
│     ●    ●─────●  (selected)    │ Domain: db   │
│      \  /                        │ Conf: 0.85   │
│       ●                          │              │
│                                  │ PostgreSQL   │
│  [zoom+] [zoom-] [fit]          │ connection   │
│                                  │ pooling was  │
│  Legend:                         │ chosen for...│
│  ● observation  ● entity        │              │
│  ● domain-summary               │ Links:       │
│                                  │ → k-def (rel)│
│  Filters:                        │ → k-ghi (dep)│
│  [domain ▾] [type ▾] [conf ━━●] │              │
└──────────────────────────────────┴──────────────┘
```

---

## 3. Semantic Search (Upgraded)

**Replaces the current substring search across all views.**

### Backend Change

Replace the naive search in `GET /resources/:id/content/search` with minimem's actual hybrid search engine:

```typescript
// Current (naive)
if (lines[i].toLowerCase().includes(queryLower)) { ... }

// Proposed
const mem = await Minimem.create({ memoryDir: localPath, embedding: { provider: 'auto' } });
const results = await mem.search(query, { maxResults: limit, minScore: 0.3 });
```

This gives us:
- **Vector similarity** (70% weight) — finds semantically related content even without keyword match
- **BM25 full-text** (30% weight) — handles exact matches and rare terms
- **Relevance scores** (0-1) — meaningful ranking instead of occurrence counting
- **Chunk boundaries** — results mapped to specific content chunks, not raw lines
- **Heading context** — which section the match is in

### Search Result Display

Each result shows:
- File path + heading context (e.g., `memory/2026-03-26.md > ## Database Decision`)
- Relevance score bar (visual, 0-1)
- Content snippet with the matching chunk highlighted
- Frontmatter tags if present (type, domain, entities)

### Knowledge-Filtered Search

Add filter controls above search results:
- Domain dropdown (populated from indexed domains)
- Entity dropdown (populated from indexed entities)
- Type dropdown (observation / entity / domain-summary)
- Min confidence slider

These map to the existing `/content/knowledge` endpoint parameters.

### Fallback

If minimem's embedding provider is not configured (no API key, no local model), fall back to BM25-only mode (`provider: 'none'`). This still provides better search than substring matching via FTS5 tokenization and ranking.

If minimem is not installed at all, fall back to current substring search with a subtle "basic search" indicator.

---

## 4. Realtime Updates

### Event Flow

```
Agent writes to memory/2026-03-26.md
  → minimem re-indexes (if daemon running)
  → Agent pushes to git remote
  → OpenHive receives x-openhive/memory.sync via MAP
  → OpenHive broadcasts to resource:memory_bank:{resourceId} channel
  → Frontend receives memory:sync event
  → React Query invalidates memory-files, memory-search, knowledge queries
  → UI re-renders with new content
```

### Frontend Changes

**New hook: `useMemoryRealtime(resourceId)`**

```typescript
export function useMemoryRealtime(resourceId: string) {
  const queryClient = useQueryClient();

  // Subscribe to resource-specific channel
  useSubscribe([`resource:memory_bank:${resourceId}`]);

  // Invalidate all memory content queries on sync
  useWSEvent('memory:sync', (data) => {
    if (data.resource_id === resourceId) {
      queryClient.invalidateQueries({ queryKey: ['memory-files', resourceId] });
      queryClient.invalidateQueries({ queryKey: ['memory-search', resourceId] });
      queryClient.invalidateQueries({ queryKey: ['memory-file', resourceId] });
      queryClient.invalidateQueries({ queryKey: ['knowledge', resourceId] });
    }
  });
}
```

**Live indicator** — when a `memory:sync` event arrives:
- Subtle pulse animation on the Memory Contents header
- Toast: "Memory updated by {agentId}" (if agent attribution available)
- New entries in timeline view slide in with `fade-in-up` animation

### Optimistic Updates

For the timeline view, when a sync event arrives with a commit hash, we can show a "new entries available" banner (like Twitter's "Show new posts") rather than auto-scrolling, to avoid disrupting the user's reading position.

---

## 5. Component Architecture

### Refactored MemoryBrowser

```
MemoryBrowser (resourceId)
├── TabBar: Timeline | Graph | Files
├── SearchBar (shared across views, triggers semantic search)
├── FilterBar (type, domain, entity, confidence — shared)
│
├── [Timeline tab]
│   └── MemoryTimeline
│       ├── DateGroup (per day)
│       │   └── MemoryEntry (card per entry)
│       │       ├── EntryHeader (time, type badge, agent)
│       │       ├── EntrySnippet (collapsed) / EntryFull (expanded)
│       │       └── EntryTags (domain, entity chips)
│       └── LoadMore (pagination)
│
├── [Graph tab]
│   └── KnowledgeGraph
│       ├── GraphCanvas (sigma.js viewer, adapted from TaskGraphViewer)
│       ├── GraphSidebar (note detail on click)
│       ├── GraphFilters (domain, type, confidence)
│       └── GraphLegend
│
├── [Files tab]
│   └── MemoryFileList (current file browser, kept as-is)
│       ├── FileViewer
│       └── SearchResults (updated to show semantic scores)
│
└── useMemoryRealtime(resourceId) — realtime subscription
```

### New Backend Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /resources/:id/content/entries` | Parsed timeline entries from all memory files |
| `GET /resources/:id/content/knowledge/graph/full` | All knowledge nodes + edges (no root required) |
| `GET /resources/:id/content/search` (upgraded) | Semantic search via minimem hybrid engine |

### Reused From Existing Code

- `TaskGraphViewer` pattern → `KnowledgeGraph` (sigma.js + graphology + ForceAtlas2)
- `TaskGraphSidebar` pattern → `GraphSidebar`
- `useTaskGraph` hook pattern → `useKnowledgeGraph`
- `STATUS_COLORS` pattern → `KNOWLEDGE_TYPE_COLORS`
- `useResourcesRealtime` pattern → `useMemoryRealtime`

---

## 6. Color System

Extend the existing status color palette for knowledge types:

| Element | Color | CSS Variable |
|---------|-------|-------------|
| Observation nodes/badges | Blue `#3b82f6` | `--color-node-blue` (existing) |
| Entity nodes/badges | Green `#22c55e` | `--color-node-green` (existing) |
| Domain-summary nodes/badges | Amber `#f59e0b` | `--color-honey-500` (existing) |
| Decision type badge | Purple `#7c3aed` | `--color-accent` (existing) |
| Bugfix type badge | Red `#ef4444` | `--color-node-red` (existing) |
| Discovery type badge | Teal `#14b8a6` | New |
| Feature type badge | Blue `#3b82f6` | `--color-node-blue` (existing) |
| Context/note badge | Gray `#6b7280` | `--color-node-gray` (existing) |
| Confidence bar | Honey gradient | `honey-400` → `honey-600` |

---

## 7. Implementation Order

1. **Realtime hook** — `useMemoryRealtime` (small, high value, unblocks live testing)
2. **Semantic search backend** — upgrade `/content/search` to use `Minimem.create()`
3. **Timeline backend** — `GET /content/entries` endpoint
4. **Timeline UI** — `MemoryTimeline` component
5. **Knowledge graph full endpoint** — `GET /content/knowledge/graph/full`
6. **Knowledge graph UI** — `KnowledgeGraph` component (adapt from TaskGraphViewer)
7. **Filter bar** — shared filters across timeline + search + graph
8. **Search UI upgrade** — show scores, chunks, heading context

---

## 8. Open Questions

- **Minimem instance lifecycle**: Should we keep a warm `Minimem` instance per resource, or create/dispose per request? Warm instances are faster but consume memory for the embedding index.
- **Embedding provider for server-side search**: OpenHive server needs an embedding provider configured. Should this be per-resource config, or a global OpenHive setting?
- **Entry parsing heuristics**: Daily log splitting by `### ` headings works for the recommended format, but agents may use different patterns. How strict should parsing be?
- **Graph scale**: ForceAtlas2 works well up to ~500 nodes. For larger knowledge bases, we may need clustering or level-of-detail rendering. Acceptable limit for v1?

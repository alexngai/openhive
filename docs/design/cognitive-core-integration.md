# Cognitive-Core Integration Design

> Living design doc for integrating cognitive-core's learning engine with OpenHive.
> Last updated: 2026-03-31

## Status: Draft

## Table of Contents

- [Overview](#overview)
- [Goals](#goals)
- [Architecture](#architecture)
- [Programmatic vs Agentic Split](#programmatic-vs-agentic-split)
- [Integration Points](#integration-points)
  - [1. Atlas Service (Programmatic Layer)](#1-atlas-service-programmatic-layer)
  - [2. Swarm Agent Backend (Agentic Layer)](#2-swarm-agent-backend-agentic-layer)
  - [3. Trajectory Ingestion](#3-trajectory-ingestion)
  - [4. Learning UI & Observability](#4-learning-ui--observability)
  - [5. Cross-Hive Knowledge Sync](#5-cross-hive-knowledge-sync)
  - [6. Hive-as-Compute for Learning](#6-hive-as-compute-for-learning)
- [Data Flow](#data-flow)
- [API Surface](#api-surface)
- [Configuration](#configuration)
- [Migration & Rollout](#migration--rollout)
- [Design Decisions](#design-decisions)
- [Open Questions](#open-questions)

---

## Overview

cognitive-core is a three-speed learning engine that processes agent trajectories into reusable playbooks, knowledge notes, and causal models. OpenHive already collects trajectory data from connected swarms via MAP and has resource infrastructure for memory banks, skills, and tasks.

This integration embeds cognitive-core's **programmatic Atlas service** directly in OpenHive (~90% of the learning pipeline — no LLM needed). For the optional agentic analysis tasks (~10% — LLM-assisted playbook extraction, efficacy audits), OpenHive **borrows agents from hosted/connected swarms**. OpenHive owns all learning persistence and provides direct API access — no proxy layer needed.

### What cognitive-core produces

| Speed | Trigger | Output | Latency | Requires LLM? |
|-------|---------|--------|---------|---------------|
| Instant | Every trajectory | Experience record, playbook confidence bumps, knowledge notes, causal edges, reflexions | <200ms | No |
| Batch (heuristic) | Energy threshold or N trajectories | Playbook extraction, temporal compression, clustering, meta-learning | Seconds | No |
| Batch (agentic) | Complexity > threshold | LLM-assisted playbook extraction, knowledge extraction | Minutes | Yes (optional) |
| Maintenance (core) | Circadian gate / manual | Healing, knowledge defrag, meta-strategies | Seconds | No |
| Maintenance (efficacy) | Periodic / manual | Playbook efficacy audit, lifecycle review | Minutes | Yes (optional) |

### Existing integration surface

| Package | OpenHive integration | cognitive-core role |
|---------|---------------------|-------------------|
| **sessionlog** | Trajectory checkpoints via MAP, local transcript lookup | Trajectory source (SessionBank reads session records) |
| **minimem** | Memory bank file listing, BM25 search, knowledge graph | Knowledge search provider (hybrid BM25+vector) |
| **skill-tree** | Skill discovery from `.skilltree/` dirs | Output sink (SkillPublisher writes playbooks as skills) |
| **opentasks** | Task graph CRUD via daemon IPC + graph.jsonl | No direct integration yet |

The gap: no code currently instantiates cognitive-core's `Atlas` or feeds it trajectories.

---

## Goals

1. **Trajectory → Learning pipeline**: Feed OpenHive's collected trajectory data into cognitive-core's `processTrajectory()` to produce playbooks and knowledge
2. **Observability**: UI to inspect learning state (playbooks, experiences, knowledge graph, learning cycle stats) and trigger batch/maintenance cycles
3. **Cross-hive sync**: Federate learned playbooks and knowledge across hive instances using the existing mesh sync protocol
4. **Distributed compute**: Allow hives to offload or distribute batch/maintenance learning cycles to peer hives

---

## Architecture

```
OpenHive server
│
├── Atlas Service (programmatic, no LLM)
│   ├── cognitive-core Atlas instance
│   │   ├── MemorySystem (experiences, playbooks, knowledge)
│   │   ├── UnifiedLearningPipeline
│   │   │   ├── InstantLoop (per-trajectory, <200ms)
│   │   │   ├── Heuristic batch (pattern matching, clustering, compression)
│   │   │   └── Maintenance (healing, defrag, meta-strategies)
│   │   ├── SessionBank[] (multi-project, reads from config.sessionlog.sessionDirs)
│   │   ├── SkillPublisher → .skilltree/
│   │   └── KnowledgeBank → markdown files
│   ├── cognitive-core.db (local SQLite persistence)
│   └── AgenticTaskRunner with SwarmAgentBackend
│       └── When complexity > heuristic threshold:
│           dispatches workspace template to borrowed swarm agent
│
├── Learning API routes (direct Atlas access — no proxy)
│   ├── /api/v1/learning/stats → atlas.getStats()
│   ├── /api/v1/learning/playbooks → memory.queryPlaybooks()
│   ├── /api/v1/learning/batch → atlas.runBatchLearning()
│   └── etc.
│
├── Resource registration
│   ├── .skilltree/ registered as skill resource
│   └── knowledge/ registered as memory_bank resource
│
└── SwarmAgentBackend (bridges to swarms for agentic tasks)
    ├── Resolves swarm: preferred → available → spawn ephemeral
    ├── Sends workspace template task via MAP
    ├── Swarm spawns worker, executes, returns result
    └── Result fed back to Atlas pipeline

Hosted/connected swarm (macro-agent)
├── Receives workspace template tasks from OpenHive
├── Spawns worker agent to execute (isolated worktree)
├── Returns structured results (extracted playbooks, knowledge, analysis)
└── No cognitive-core dependency — just executes tasks
```

**Key principle**: OpenHive owns Atlas (persistence, pipeline, API). Swarms are just compute — they receive well-defined tasks and return structured results. Any capable swarm works.

---

## Programmatic vs Agentic Split

cognitive-core's pipeline is ~90% programmatic. The `if (this.taskRunner)` guard in the UnifiedLearningPipeline determines whether agentic workspace templates are used. Without a taskRunner, everything falls back to heuristic execution.

### Programmatic (runs in OpenHive, no LLM)

| Component | What it does |
|-----------|-------------|
| InstantLoop | Store experience, bump playbook confidence, extract knowledge (regex/rules), causal edges, reflexion |
| Analyzer | Credit assignment via exponential decay — pure math |
| PlaybookExtractor (heuristic) | Pattern matching on action sequences, text normalization |
| KnowledgeExtractor (heuristic) | Error pattern regex, config fact detection, causal chain inference, entity identification |
| TemporalCompressor | Hot → warm → cold → evicted tier promotion/demotion |
| ReasoningBank | K-means++ clustering of experiences |
| MetaLearner | Routing strategy generation from success/failure patterns |
| EnergyEvaluator | Batch trigger decision (count/time thresholds, domain novelty) |
| HealingOrchestrator | Anomaly detection (drift, bloat, Z-score) + repair strategies |
| KnowledgeDefrag | Deduplication via text similarity |
| MaintenanceScheduler | Circadian gating, cycle orchestration |
| SkillPublisher | Playbook → skill-tree format conversion |
| SessionBank | Reads sessionlog orphan branch, tracks processing state |

### Agentic (dispatched to borrowed swarm agents, optional)

| Component | When triggered | What the agent does |
|-----------|---------------|-------------------|
| Trajectory analysis template | Batch, if complexity ≥ 'standard' | Semantic analysis of complex/failed trajectories |
| Playbook extraction template | Batch, if batch > 3 trajectories | Semantic pattern identification across trajectory clusters |
| Knowledge extraction template | Batch, if complexity ≥ 'standard' | Rich knowledge extraction from complex trajectories |
| Playbook efficacy audit | Maintenance, if enabled | Reviews playbook effectiveness, usage patterns |
| Playbook lifecycle review | Maintenance, periodic | Identifies stale/redundant playbooks, recommends retirement |

**Phase 1 runs fully programmatic** — `taskRunner` is unset, all agentic templates fall back to heuristics. Swarm borrowing is Phase 2.

---

## Integration Points

### 1. Atlas Service (Programmatic Layer)

**Goal**: Run cognitive-core's Atlas as a Fastify plugin within OpenHive.

```typescript
// src/learning/atlas-service.ts — Fastify plugin
const atlas = createAtlas({
  storage: { baseDir: config.dataDir + '/cognitive-core', persistenceEnabled: true },
  learning: { creditStrategy: 'simple', minTrajectories: 5 },
  knowledgeBank: { enabled: true, minimemAware: true },
  skillTree: { enabled: true },
  sessionBank: { enabled: true, autoIngest: false },
  embedding: { provider: 'none' },
  features: { instantLoop: true, reflexion: true, causalExtraction: true },
  // taskRunner NOT set in Phase 1 → fully programmatic
});
await atlas.init();
```

**Lifecycle**: Initialized on server startup (after database ready), closed on shutdown. Decorated onto the Fastify instance as `server.atlas` following the pattern of `server.swarmManager` and `server.syncService`.

**SessionBank config**: Reads sessionlog data directly — OpenHive runs on the same machine as the agents producing sessions. SessionBank configured with the project repo path(s) and orphan branch name. Supports multiple repos via sessionlog's own configuration.

**Persistence**: `cognitive-core.db` lives under `{dataDir}/cognitive-core/`. Knowledge files and `.skilltree/` also under this directory. All co-located with OpenHive data, included in backups.

**Files to create/modify**:
- `src/learning/atlas-service.ts` — Atlas Fastify plugin (lifecycle, config, decoration)
- `src/config.ts` — Add `learning` config section
- `src/server.ts` — Register atlas-service plugin

### 2. Swarm Agent Backend (Agentic Layer)

**Goal**: When Atlas needs LLM-assisted analysis, borrow agents from a hosted/connected swarm.

cognitive-core's `AgenticTaskRunner` calls `AgentBackend.spawn(config)` with a workspace template task. OpenHive implements `SwarmAgentBackend` that dispatches this to a swarm:

```typescript
// src/learning/swarm-agent-backend.ts
class SwarmAgentBackend implements AgentBackend {
  readonly name = 'openhive-swarm';
  readonly supportedTypes = ['claude-code'];

  async spawn(config: AgentSpawnConfig): Promise<AgentSession> {
    // 1. Resolve a swarm (preferred → available → spawn ephemeral)
    const swarmId = await this.resolveSwarm();

    // 2. Send workspace template task to swarm
    //    Task is self-contained: description + input data + expected output format
    const requestId = nanoid();
    sendToSwarm(swarmId, {
      jsonrpc: '2.0',
      method: 'x-openhive/learning.workspace.execute',
      params: {
        request_id: requestId,
        task: {
          description: config.task.description,
          domain: config.task.domain,
          context: config.task.context,
        },
        injected_knowledge: config.systemPromptAdditions,
        timeout: config.timeout,
      },
    });

    // 3. Wait for result via response notification
    const result = await this.waitForResult(requestId);
    return this.buildSession(config, result);
  }
}
```

**Swarm resolution**:
1. **Preferred swarm** — `learning.compute.preferredSwarmId` if configured and online
2. **Available connected swarm** — LRU among connected swarms
3. **Spawn ephemeral** — Via SwarmManager if `spawnIfNoneAvailable: true`

**Swarm-side handling**: macro-agent's `orchestration` branch includes a full `src/cognitive/` module with:
- `MacroAgentBackend` — Implements cognitive-core's `AgentBackend` interface natively
- `AnalystRole` — Minimal role for cognitive analysis agents (reads input/, writes output/, calls done())
- `SessionConverter` — Converts ACP protocol updates to cognitive sessions in real-time
- `TrajectoryExtractor` — Converts completed sessions to ReAct-format trajectories
- `ACP extensions` (`_macro/cognitive/command`, `status`, `query`) — For Atlas-level operations
- `TeamLifecycle` — Factory for initializing cognitive-ops teams

When OpenHive dispatches a workspace task to a swarm running macro-agent with cognitive integration, the flow is:
1. `x-openhive/learning.workspace.execute` MAP message arrives at the swarm
2. Swarm's handler spawns an analyst agent via `MacroAgentBackend.spawn()`
3. Agent executes in the workspace `cwd`, reads input files, writes output files
4. Agent calls `done()`, trajectory is extracted
5. Result sent back via `x-openhive/learning.workspace.result`

**Protocol**: MAP extension methods for the agentic layer:

| Method | Direction | Description |
|--------|-----------|-------------|
| `x-openhive/learning.workspace.execute` | Hive → Swarm | Send workspace template task for agent execution |
| `x-openhive/learning.workspace.result` | Swarm → Hive | Return structured analysis results |
| `_macro/cognitive/command` | (Swarm internal) | Dispatch Atlas operations (extract, query, prune) |
| `_macro/cognitive/status` | (Swarm internal) | Query Atlas availability |

**Phase 2**: Wire `SwarmAgentBackend` into Atlas as the `AgenticTaskRunner`. Set on Atlas after a swarm is available.

**Files to create**:
- `src/learning/swarm-agent-backend.ts` — AgentBackend implementation
- `src/map/learning-handler.ts` — MAP handler for workspace result notifications

### 3. Trajectory Ingestion

**Goal**: Feed sessionlog trajectory data into Atlas.

OpenHive reads sessionlog directly — no injection into a separate swarm needed. SessionBank is configured with the project repo path and reads the orphan branch natively.

**Deferred processing (Phase 1)**: When a session closes (swarm goes `online → offline`), OpenHive triggers ingestion:

```typescript
// src/learning/ingestion.ts
async function onSessionClose(sessionResourceId: string) {
  const sessionBank = server.atlas.getSessionBank();
  const sessions = await sessionBank.query({ unprocessedOnly: true });
  for (const session of sessions.sessions) {
    const trajectory = trajectorySource.synthesize(session);
    await server.atlas.processTrajectory(trajectory);
    await sessionBank.markProcessed(session.sessionId);
  }
}
```

**Session close detection**: Hook into the swarm lifecycle status change (`online → unreachable → offline`) which OpenHive already tracks. When a swarm goes offline, trigger ingestion for its active sessions.

**Files to create/modify**:
- `src/learning/ingestion.ts` — Session close detection + ingestion trigger
- `src/map/trajectory-handler.ts` — Hook ingestion into existing checkpoint handler

### 4. Learning UI & Observability

**Goal**: Dashboard for inspecting and controlling the learning engine.

All routes read directly from Atlas — no MAP proxy needed.

#### API Routes

```
GET    /api/v1/learning/stats           — atlas.getStats()
GET    /api/v1/learning/playbooks       — memory.queryPlaybooks()
GET    /api/v1/learning/playbooks/:id   — memory.getPlaybook(id)
GET    /api/v1/learning/knowledge       — knowledgeBank.search()
GET    /api/v1/learning/knowledge/:id   — knowledgeBank.getNote(id)
GET    /api/v1/learning/experiences     — memory.queryExperiences()
GET    /api/v1/learning/activity        — pipeline event log
POST   /api/v1/learning/batch           — atlas.runBatchLearning()
POST   /api/v1/learning/maintenance     — maintenance scheduler trigger
GET    /api/v1/learning/config          — current learning config
PATCH  /api/v1/learning/config          — atlas.updateConfig()
GET    /api/v1/learning/health          — pipeline stats + swarm backend health
```

#### WebSocket Events

```
learning:instant      — After each instant loop
learning:batch        — When batch learning completes
learning:maintenance  — When maintenance cycle completes
```

#### Dashboard Sections

- **Stats Overview**: Experience count, playbook count, trajectories processed, skill library counts
- **Playbook Library**: List with domain/confidence/success rate, detail view with evolution history
- **Knowledge Notes**: List + search (minimem-backed if available), filterable by type/domain
- **Learning Activity**: Timeline of learning events, energy level indicator
- **Controls**: Trigger batch/maintenance, configure parameters

**Files to create**:
- `src/api/routes/learning.ts` — Learning API routes
- `src/web/pages/Learning.tsx` — Learning dashboard
- `src/web/pages/LearningPlaybookDetail.tsx` — Playbook detail view
- `src/web/components/learning/` — Dashboard components

### 5. Cross-Hive Knowledge Sync

**Goal**: Federate playbooks and knowledge across hive instances.

#### Sync Units

| Artifact | Sync format | Sync mechanism |
|----------|-------------|----------------|
| Playbooks | JSON (Playbook schema) | `resource_published` / `resource_synced` events via mesh sync |
| Knowledge notes | Markdown + YAML frontmatter | `resource_synced` events (file-level changes) |
| Skills (derived) | skill-tree format | Already syncable as `skill` resources |
| Experiences | Not synced (instance-specific) | — |
| Meta-learning | Not synced (instance-specific) | — |

#### New Resource Type: `playbook`

```typescript
type SyncableResourceType = 'memory_bank' | 'task' | 'skill' | 'session' | 'playbook'
```

**Conflict resolution**: Higher confidence wins, union of refinements, keep both evolution histories. Imported playbooks get `provenance.origin = 'imported'`.

**Files to modify**:
- `src/types.ts` — Add `'playbook'` to SyncableResourceType
- `src/sync/materializer.ts` — Handle playbook materialization
- `src/learning/sync.ts` — Emit sync events, import remote playbooks

### 6. Hive-as-Compute for Learning

**Goal**: Distribute batch and maintenance learning across hive instances.

Two modes:

**Centralized**: One hive runs Atlas for a cluster. Peer hives sync sessionlog data to it. Results propagate via mesh sync.

**Domain-partitioned**: Different hives specialize in different domains. Each hive's Atlas is configured with domain filtering.

**Files to create**:
- `src/learning/distributed.ts` — Cross-hive learning coordination

---

## Data Flow

### End-to-End: Trajectory → Learning → Sync

```
┌─────────────┐                       ┌──────────────────────────────────────┐
│ Agent/Swarm  │  sessionlog hooks     │ OpenHive                             │
│ (cc-swarm)   │ ──────────────────┐  │                                      │
└─────────────┘                    │  │  trajectory-handler.ts                │
       │ MAP checkpoint            │  │    ├─ store checkpoint (DB)           │
       └───────────────────────────┼─▶│    ├─ broadcast WS event              │
                                   │  │    └─ detect session close             │
                                   │  │                                        │
                                   │  │  Atlas Service (programmatic)          │
                                   │  │    ├─ SessionBank reads sessionlog     │
                                   ▼  │    ├─ processTrajectory()              │
                              sessionlog   │    │                              │
                              orphan branch│    ├─ Instant loop                │
                                   │  │    │   ├─ store experience             │
                                   │  │    │   ├─ bump playbooks               │
                                   │  │    │   ├─ extract knowledge            │
                                   │  │    │   └─ broadcast learning:instant   │
                                   │  │    │                                   │
                                   │  │    └─ (if energy triggered) Batch      │
                                   │  │       ├─ heuristic extraction (local)  │
                                   │  │       ├─ OR agentic → borrow swarm ────┼──┐
                                   │  │       ├─ publish to .skilltree/        │  │
                                   │  │       ├─ write knowledge notes         │  │
                                   │  │       └─ broadcast learning:batch      │  │
                                   │  │                                        │  │
                                   │  │  Resource registration                 │  │
                                   │  │    ├─ .skilltree/ → skill resource     │  │
                                   │  │    └─ knowledge/ → memory_bank         │  │
                                   │  │                                        │  │
                                   │  │  mesh sync → peer hives               │  │
                                   │  └──────────────────────────────────────┘  │
                                   │                                            │
                                   │  ┌────────────────────────────────────┐    │
                                   │  │ Swarm (borrowed for agentic tasks) │◄───┘
                                   │  │  ├─ receives workspace template    │
                                   │  │  ├─ spawns worker agent            │
                                   │  │  ├─ returns structured results     │
                                   │  │  └─ no cognitive-core dependency   │
                                   │  └────────────────────────────────────┘
```

### Learning Dashboard Data Flow

```
┌──────────────┐   GET /learning/*   ┌──────────────────────────────┐
│ React UI     │ ◄────────────────── │ OpenHive learning routes      │
│ Learning.tsx │                      │  ├─ direct Atlas access       │
│              │   WS learning:*     │  │  atlas.getStats()          │
│              │ ◄────────────────── │  │  memory.queryPlaybooks()   │
└──────────────┘                      │  └─ no proxy, no MAP msgs    │
                                      └──────────────────────────────┘
```

---

## API Surface

### Learning Routes (`/api/v1/learning/`)

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/stats` | Atlas stats (counts, pipeline state) | Bearer |
| GET | `/playbooks` | List playbooks with filtering | Bearer |
| GET | `/playbooks/:id` | Playbook detail with evolution | Bearer |
| GET | `/knowledge` | Knowledge notes with search | Bearer |
| GET | `/knowledge/:id` | Knowledge note detail | Bearer |
| GET | `/experiences` | Recent experiences | Bearer |
| GET | `/experiences/:id` | Experience detail | Bearer |
| GET | `/activity` | Learning event timeline | Bearer |
| POST | `/batch` | Trigger batch learning | Admin |
| POST | `/maintenance` | Trigger maintenance cycle | Admin |
| GET | `/config` | Current learning config | Admin |
| PATCH | `/config` | Update learning config | Admin |
| GET | `/health` | Learning engine + swarm backend health | Bearer |

### MAP Extension Methods (Agentic Layer Only)

| Method | Direction | Description |
|--------|-----------|-------------|
| `x-openhive/learning.workspace.execute` | Hive → Swarm | Send workspace template task for agent execution |
| `x-openhive/learning.workspace.result` | Swarm → Hive | Return structured analysis results |

MAP messages are only used for the optional agentic layer (dispatching workspace templates to swarms). All other learning operations (stats, batch trigger, maintenance, ingestion) are direct function calls within OpenHive.

---

## Configuration

```javascript
// openhive.config.js
{
  learning: {
    enabled: true,                    // Master toggle

    // Atlas config
    atlas: {
      creditStrategy: 'simple',       // 'simple' | 'causal'
      minTrajectories: 5,             // Batch trigger threshold
      maxExperiences: 4,              // Per-query memory limit
      maxContextTokens: 4000,
      embedding: { provider: 'none' },// Default: BM25/text-similarity
    },

    // Ingestion behavior
    ingestion: {
      mode: 'deferred',             // 'deferred' (Phase 1) | 'hybrid' (future)
    },

    // Agentic compute (Phase 2+)
    compute: {
      enabled: false,                // Enable agentic workspace templates
      preferredSwarmId: null,        // Specific swarm, or null for auto-select
      spawnIfNoneAvailable: true,    // Spawn ephemeral swarm if needed
      spawnProvider: 'local',        // 'local' | 'sandboxed'
    },

    // Cross-hive sync
    sync: {
      publishPlaybooks: true,
      importPlaybooks: true,
      conflictStrategy: 'merge',     // 'merge' | 'local-wins' | 'remote-wins'
    },

    // Distributed compute (Phase 4)
    distributed: {
      mode: 'local',                 // 'local' | 'centralized' | 'domain-partitioned'
      learningHiveUrl: null,
      domainRouting: {},
    },

    // Scheduling
    maintenance: {
      schedule: '0 3 * * *',        // Cron for maintenance cycle
      autoRun: true,
    },
  }
}
```

---

## Migration & Rollout

### Phase 1: Programmatic Learning — IMPLEMENTED

**1. Foundation** ✅
- [x] `cognitive-core@0.1.2` added as dependency
- [x] `learning` config section with Zod schema (`enabled`, `atlas`, `ingestion`, `compute`, `sync`, `distributed`, `maintenance`)
- [x] `OPENHIVE_LEARNING_ENABLED` env var override
- [x] `learning:instant`, `learning:batch`, `learning:maintenance` WS event types

**2. Atlas service plugin** (`src/learning/atlas-service.ts`) ✅
- [x] Atlas lifecycle (init on startup after DB ready, close on shutdown)
- [x] Decorated onto Fastify as `server.atlasService`
- [x] Multi-project SessionBank support via `config.sessionlog.sessionDirs`
  - [x] Resolves repo paths from sessionDir paths (handles `.git/sessionlog-sessions/` and standalone repos)
  - [x] Falls back to cwd when no sessionDirs configured
  - [x] Multiple SessionBanks for multi-project hives
- [x] SkillPublisher + KnowledgeBank under `{dataDir}/cognitive-core/`
- [x] `taskRunner` NOT set → fully programmatic
- [x] Graceful degradation (init errors caught, routes return 503, server continues)
- [x] Configurable logger
- [x] Maintenance scheduler (hourly check, runs at configured cron hour, max once/day)
- [x] `getDetailedStatus()` for monitoring (session banks, maintenance state, counts)

**3. Trajectory ingestion** (`src/learning/ingestion.ts`) ✅
- [x] Hook via `mapHubEvents.swarm_offline` (emitted on WS disconnect, heartbeat timeout, stale sweep)
- [x] Async queue (sequential, non-blocking)
- [x] Scans all configured SessionBanks for unprocessed sessions
- [x] `EntireTrajectorySource.synthesize()` → `atlas.processTrajectory()`
- [x] Per-session error handling (skip and continue)
- [x] WS event broadcast after each trajectory

**4. Learning API routes** (`src/api/routes/learning.ts`) ✅
- [x] GET `/stats`, `/playbooks` (paginated/filtered/sorted), `/playbooks/:id`
- [x] GET `/knowledge` (searchable), `/knowledge/:id`
- [x] GET `/experiences` (paginated/filterable)
- [x] POST `/batch`, `/maintenance`
- [x] GET `/health` — detailed monitoring (session banks, maintenance, agentic compute)
- [x] All return 503 when disabled, Zod schemas for query params

**5. Resource registration** ✅
- [x] `.skilltree/` registered as `skill` resource
- [x] `knowledge/` registered as `memory_bank` resource

**6. WebSocket events** ✅
- [x] `learning:instant`, `learning:batch`, `learning:maintenance` broadcast via `broadcastToChannel`

**7. Testing** ✅
- [x] 8 atlas-service tests (init, disable, directories, stats, trajectory processing, batch, graceful degradation)
- [x] 12 route tests (all endpoints enabled, 503 disabled, trajectory data flow)

### Phase 1.5: Agentic Analysis (swarm borrowing) — IMPLEMENTED

- [x] `SwarmAgentBackend` (`src/learning/swarm-agent-backend.ts`)
  - [x] Swarm resolution (preferred → LRU → spawn ephemeral)
  - [x] `x-openhive/learning.workspace.execute` / `.result` MAP messages
  - [x] 5-minute timeout, error handling
- [x] Notification interceptor in `ws-map.ts` for `workspace.result`
- [x] `atlas.setAgentManager([backend])` wiring in server.ts
  - [x] Conditional: only when `learning.compute.enabled` and a swarm is available
- [x] `/health` route includes `agentic_compute` status

### Phase 2: UI & Observability — IMPLEMENTED

- [x] Learning dashboard page (`/learning`) with 4 tabs (overview, playbooks, knowledge, experiences)
- [x] Playbook list + detail views with full playbook inspection
- [x] Knowledge notes browser with search
- [x] Learning activity timeline (in-memory ring buffer, API + UI)
- [x] Session detail "Learning" tab with stats and link to dashboard
- [x] Batch/maintenance trigger controls (admin-only via adminAuth)
- [x] Admin auth on mutation routes (POST batch/maintenance), read routes use authMiddleware
- [x] Real-time invalidation via `useLearningRealtime()` hook
- [x] 49 tests across 3 files (atlas-service, routes, sync)

### Phase 3: Cross-Hive Sync — IMPLEMENTED

- [x] `'playbook'` added to `SyncableResourceType` and `ResourcePublishedPayload`
- [x] `PlaybookResourceMetadata` type added (playbook_count, domains, avg_confidence, provenance)
- [x] `emitBatchSyncEvents()` in `src/learning/sync.ts` — emits `resource_synced` after batch learning
- [x] Skill and knowledge resource IDs tracked in AtlasService for sync emission
- [x] Sync emission gated by `learning.sync.publishPlaybooks` config
- [x] Knowledge sync via existing `memory_bank` resource infrastructure (no changes needed)
- [x] Materializer handles incoming playbook resources generically (existing `resource_published` flow)
- [x] 6 sync-specific tests

### Phase 4: Distributed Compute — IMPLEMENTED

- [x] `DistributedLearningCoordinator` (`src/learning/distributed.ts`)
  - [x] Three modes: `local`, `centralized`, `domain-partitioned`
  - [x] `resolveTarget(domain)` → 'local' or remote hive URL
  - [x] `forwardTrajectory()` — HTTP POST to remote hive's `/learning/ingest`
  - [x] `checkRemoteHealth()` — pings remote `/learning/health`
  - [x] `getStatus()` — full distributed status for monitoring
- [x] Centralized learning hive mode: all trajectories forwarded to `learningHiveUrl`
- [x] Domain-partitioned routing: per-domain hive URLs via `domainRouting` config
- [x] Fallback to local processing when forwarding fails or no URL configured
- [x] Ingestion flow respects distributed routing (forwards or processes locally per trajectory)
- [x] `POST /learning/ingest` endpoint — receives forwarded trajectories from peer hives
- [x] Health monitoring: distributed status included in `/learning/health` response
- [x] 11 distributed-specific tests (local/centralized/domain-partitioned routing, status, forwarding, Atlas integration)

### Future: Team Learning (Design Objective)

- [ ] Team trajectory synthesis from correlated sessions (sessionlog + openteams)
- [ ] `atlas.processTeamTrajectory()` integration
- [ ] Team playbook extraction (role composition, handoff patterns)

### Future: opentasks Enrichment (Design Objective)

- [ ] Task metadata enrichment for trajectories (task description, domain, dependencies)
- [ ] Scoped trajectory analysis (task + trajectory combos)
- [ ] Task-level learning insights (effort estimates, playbook suggestions)

---

## Design Decisions

### 1. Embedding provider → Default `none`

Default to `none` (BM25/text-similarity fallback). Users opt into vector search via Atlas config. When minimem is available, it brings its own embedding config for knowledge search.

### 2. Atlas location → Embedded in OpenHive (programmatic service)

Atlas runs directly in OpenHive as a Fastify plugin. cognitive-core's pipeline is ~90% programmatic (no LLM) — there's no reason to push it into a separate swarm process.

**Why this changed from "dedicated learning swarm"**: Analysis of cognitive-core's codebase revealed that the `UnifiedLearningPipeline` is almost entirely heuristic/code-based. The `if (this.taskRunner)` guard means everything falls back to programmatic execution when no agent runner is configured. Only workspace templates (complex batch analysis, efficacy audits) need LLM agents.

**Benefits**:
- Direct API access — no MAP message proxying for stats, playbooks, batch triggers
- OpenHive owns persistence — `cognitive-core.db`, knowledge, skills all local
- Phase 1 needs zero swarm infrastructure — fully programmatic
- Simpler debugging and observability — everything in one process
- SessionBank reads sessionlog directly — no resource injection needed

**For agentic tasks**: OpenHive implements `SwarmAgentBackend` that dispatches workspace template tasks to borrowed swarm agents. The scope is narrow (well-defined input/output) and optional.

### 3. Swarm borrowing for agentic tasks

When Atlas's pipeline decides a workspace template needs LLM analysis, `SwarmAgentBackend` dispatches to a hosted/connected swarm. The swarm receives a self-contained task (description + input data + expected output format) and returns structured results. The swarm doesn't need cognitive-core — it's executing a generic analysis task.

**Protocol**: Two MAP extension methods (`workspace.execute` / `workspace.result`) — request-response pattern similar to `trajectory/content.request` / `trajectory/content.response`.

**Swarm resolution**: Preferred → LRU among connected → spawn ephemeral via SwarmManager.

### 4. Playbook manifestation → skill-tree

Playbooks manifest as skills via SkillPublisher → `.skilltree/`. Agents load them through standard skill-tree discovery. The `/api/v1/learning/playbooks` routes are for observability, not agent consumption.

### 5. Team learning → Deferred (design objective)

Deferred past Phase 4. Requires `TeamTrajectory` synthesis from correlated sessions via sessionlog + openteams.

### 6. opentasks integration → Deferred (design objective)

opentasks provides scoped trajectories (task + trajectory combos). Deferred to Phase 3+.

### 7. Storage isolation → Fully independent per hive

Each hive's `cognitive-core.db` and knowledge files are fully isolated. Cross-hive sharing through sync layer only.

### 8. Retention policy → cognitive-core owns it, config exposed

cognitive-core's temporal compression handles retention. OpenHive exposes config knobs via `learning.atlas` but doesn't add hive-level policies.

### 9. Skill-tree publish frequency → Immediate, configurable via cognitive-core

Publish after each batch run. Imported playbooks not re-published (prevents mesh echo).

### 10. Knowledge graph UI → Deferred

List + search in Phase 2. Interactive graph visualization deferred.

### 11. Coordination protocol → Direct for programmatic, MAP for agentic only

All programmatic learning operations (ingestion, batch trigger, stats, maintenance) are direct function calls within OpenHive. MAP extension messages are only used for the optional agentic layer — dispatching workspace template tasks to swarms and receiving results. This replaces the previous design which used MAP messages for all control plane communication.

---

### 12. cognitive-core dependency → Full dependency

cognitive-core is a regular `dependencies` entry in `package.json`. The `learning.enabled` config flag gates all learning functionality at runtime — when disabled, Atlas is never initialized and the dependency is inert. No dynamic loading or optional dependency complexity.

### 13. SessionBank multi-project → Single SessionBank initially, designed for multi-project expansion

Phase 1: Single `SessionBank` configured with one project repo path. Covers the common case (one developer, one project).

The design accommodates multiple SessionBanks later — when multiple agents from different projects connect, OpenHive can lazily create a SessionBank per project (keyed by project path from trajectory checkpoint metadata). Each SessionBank scans its own orphan branch independently. Trajectories from different projects get different `domain` tags, so playbook extraction partitions naturally.

### 14. Workspace template task format → Serialize cognitive-core template prompts

`x-openhive/learning.workspace.execute` sends the cognitive-core workspace template prompt as the task description. The swarm agent receives it as a standard analysis task — the prompt is self-contained with all input data embedded. The swarm has no cognitive-core awareness; it just runs the prompt and returns structured JSON.

```typescript
// SwarmAgentBackend serializes the template:
{
  method: 'x-openhive/learning.workspace.execute',
  params: {
    request_id: string,
    task: {
      description: string,        // Full workspace template prompt from cognitive-core
      domain: string,
      context: {
        trajectories: Trajectory[],  // Serialized input data
        existing_playbooks: PlaybookSummary[],
      },
    },
    expected_output_schema: {     // JSON schema for structured output
      type: 'playbook_extraction' | 'trajectory_analysis' | 'knowledge_extraction' | 'efficacy_audit',
      schema: JSONSchema,
    },
    timeout: number,
  }
}
```

cognitive-core controls the analysis quality through its template prompts. The swarm is pure LLM compute. Output is validated against the schema before being fed back to Atlas.

---

## Open Questions

_No unresolved questions at this time. New questions will be added as implementation progresses._

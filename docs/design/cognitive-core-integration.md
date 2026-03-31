# Cognitive-Core Integration Design

> Living design doc for integrating cognitive-core's learning engine with OpenHive.
> Last updated: 2025-03-30

## Status: Draft

## Table of Contents

- [Overview](#overview)
- [Goals](#goals)
- [Integration Points](#integration-points)
  - [1. Trajectory Ingestion Pipeline](#1-trajectory-ingestion-pipeline)
  - [2. Learning Engine Hosting](#2-learning-engine-hosting)
  - [3. Learning UI & Observability](#3-learning-ui--observability)
  - [4. Cross-Hive Knowledge Sync](#4-cross-hive-knowledge-sync)
  - [5. Hive-as-Compute for Learning](#5-hive-as-compute-for-learning)
- [Data Flow](#data-flow)
- [Resource Types](#resource-types)
- [API Surface](#api-surface)
- [Configuration](#configuration)
- [Migration & Rollout](#migration--rollout)
- [Open Questions](#open-questions)

---

## Overview

cognitive-core is a three-speed learning engine that processes agent trajectories into reusable playbooks, knowledge notes, and causal models. OpenHive already collects trajectory data from connected swarms via MAP and has resource infrastructure for memory banks, skills, and tasks. This integration closes the loop: trajectories flow in, learning runs, and the resulting playbooks/knowledge flow back out to agents and across hives.

### What cognitive-core produces

| Speed | Trigger | Output | Latency |
|-------|---------|--------|---------|
| Instant | Every trajectory | Experience record, playbook confidence bumps, knowledge notes, causal edges, reflexions | <200ms |
| Batch | Energy threshold or N trajectories | New playbooks, playbook refinements, temporal compression, experience clustering, meta-learning | Seconds–minutes |
| Maintenance | Circadian gate / manual | Healing, knowledge defrag, meta-strategies, health reports | Minutes |

### Existing integration surface

OpenHive already integrates with cognitive-core's satellite packages:

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

## Integration Points

### 1. Trajectory Ingestion Pipeline

**Goal**: When a trajectory checkpoint arrives via MAP, feed the full transcript into cognitive-core.

**Current flow**:
```
Agent → MAP trajectory/checkpoint → trajectory-handler.ts
  → stores checkpoint in trajectory_checkpoints table
  → auto-creates session resource
  → broadcasts trajectory:sync WS event
```

**Proposed extension**:
```
Agent → MAP trajectory/checkpoint → trajectory-handler.ts
  → stores checkpoint (existing)
  → resolves full transcript (5-tier resolution, existing)
  → synthesizes Trajectory object from transcript
  → atlas.processTrajectory(trajectory)
  → instant results stored/broadcast
  → batch triggered if energy threshold met
```

**Key design decisions**:

- **Synthesis adapter**: We need a `MapTrajectorySource` that converts OpenHive's session transcript (Claude JSONL → ACP events) into cognitive-core's `Trajectory` format (ReAct steps). This is similar to cognitive-core's existing `SessionTrajectorySource` but operates on ACP events rather than raw sessionlog records.

- **Async vs sync**: The instant loop (<200ms) can run synchronously on checkpoint arrival. Batch learning should be async (queued, not blocking the MAP handler). Maintenance should be scheduled or manually triggered.

- **Transcript availability**: Full transcripts aren't always available at checkpoint time (the session may still be active). Options:
  - **Eager**: Fetch transcript on every checkpoint, process immediately. High freshness, high load.
  - **Deferred**: Queue for processing after session ends (detect via swarm disconnect or explicit session close). Lower load, delayed learning.
  - **Hybrid**: Run instant loop on checkpoint metadata only (no transcript needed for experience storage + playbook confidence bumps), defer full trajectory synthesis until transcript is available.

  **Recommendation**: Hybrid. The instant loop's experience storage and playbook matching work from checkpoint metadata. Full trajectory synthesis (which needs the transcript for step extraction) runs when the session completes or content becomes available.

**Files to create/modify**:
- `src/learning/` — New directory for learning engine integration
- `src/learning/atlas-manager.ts` — Atlas lifecycle (init, config, shutdown)
- `src/learning/trajectory-adapter.ts` — ACP events → cognitive-core Trajectory conversion
- `src/learning/ingestion.ts` — Orchestrates checkpoint → learning pipeline
- `src/map/trajectory-handler.ts` — Hook into learning pipeline after checkpoint storage

### 2. Learning Engine Hosting

**Goal**: Manage a cognitive-core Atlas instance as part of the OpenHive server lifecycle.

**Atlas lifecycle**:
```typescript
// Server startup
const atlas = createAtlasWithAgents([swarmBackend], {
  storage: { baseDir: config.dataDir + '/cognitive-core', persistenceEnabled: true },
  learning: { creditStrategy: 'simple', minTrajectories: 5 },
  knowledgeBank: { enabled: true, minimemAware: true },
  skillTree: { enabled: true },
  sessionBank: { enabled: false }, // OpenHive manages trajectory ingestion directly
  embedding: { provider: 'none' }, // BM25/text-similarity, no API keys needed
  features: { instantLoop: true, reflexion: true, causalExtraction: true },
});
await atlas.init();

// Server shutdown
await atlas.close();
```

**Key decisions**:

- **Single Atlas per hive**: One Atlas instance manages all learning for the hive. Trajectories from all connected swarms feed into the same learning engine, partitioned by domain.

- **Agent backend → connected swarms**: Atlas is initialized with an `AgentBackend` that dispatches to connected/hosted swarms via MAP or SwarmManager. Batch learning workspace templates execute on swarm agents, not on the hive server. This keeps the hive lightweight and leverages existing compute. Heuristic-only extraction (no LLM) runs locally as fallback when no swarms are available.

- **Storage location**: cognitive-core's SQLite DB (`cognitive-core.db`) and knowledge files live under `{dataDir}/cognitive-core/`. This keeps them co-located with other OpenHive data and included in backups.

- **Knowledge bank ↔ minimem**: cognitive-core's KnowledgeBank writes markdown files. If `minimemAware: true`, it delegates search to minimem. OpenHive already serves minimem content via resource-content routes. The knowledge bank directory can be registered as a `memory_bank` resource for full UI access.

- **Playbooks manifest as skills**: cognitive-core's SkillPublisher converts playbooks to skill-tree format and writes to `skills.db`. Agents consume playbooks through standard skill-tree discovery (`.skilltree/` directory), not through a custom injection protocol. OpenHive registers the published skills directory as a `skill` resource.

**Files to create/modify**:
- `src/learning/atlas-manager.ts` — Atlas singleton, config from `openhive.config.js`
- `src/server.ts` — Init/close Atlas with server lifecycle
- `src/config.ts` — Add `learning` config section

### 3. Learning UI & Observability

**Goal**: Dashboard for inspecting and controlling the learning engine.

#### 3a. Learning Dashboard Page

New page at `/learning` with sections:

**Stats Overview** (from `atlas.getStats()`):
- Experience count, playbook count, meta-observation count
- Trajectories processed, pending trajectories
- Skill library counts (core, domain)

**Playbook Library**:
- List all playbooks with name, domain, confidence, success rate, last used
- Detail view: applicability, guidance, verification, evolution history
- Filter by domain, sort by confidence/usage
- Actions: trigger batch learning, view source trajectories

**Knowledge Graph**:
- Knowledge notes list with type (observation/entity/domain-summary), domain, confidence
- Graph visualization (semantic/temporal/causal/entity layers)
- Search (delegated to minimem if available)

**Learning Activity**:
- Timeline of learning events (instant results, batch runs, maintenance cycles)
- Energy level indicator (how close to batch trigger)
- Batch/maintenance cycle results

**Controls**:
- Trigger batch learning manually
- Trigger maintenance cycle
- Configure learning parameters (domain routing, batch thresholds)

#### 3b. Session Detail Enhancement

Extend the existing session detail page with a "Learning" tab:
- Show what the learning engine extracted from this session's trajectories
- Linked experiences, playbook updates, knowledge notes produced
- Playbooks that were injected (if the session was routed through Atlas)

#### 3c. API Routes

```
GET    /api/v1/learning/stats           — Atlas stats
GET    /api/v1/learning/playbooks       — List playbooks (filterable)
GET    /api/v1/learning/playbooks/:id   — Playbook detail
GET    /api/v1/learning/knowledge       — Knowledge notes (filterable)
GET    /api/v1/learning/knowledge/:id   — Knowledge note detail
GET    /api/v1/learning/experiences     — Recent experiences
GET    /api/v1/learning/activity        — Learning event timeline
POST   /api/v1/learning/batch           — Trigger batch learning
POST   /api/v1/learning/maintenance     — Trigger maintenance cycle
GET    /api/v1/learning/config          — Current learning config
PATCH  /api/v1/learning/config          — Update learning config
```

#### 3d. WebSocket Events

```
learning:instant    — Fired after each instant loop (experience stored, playbooks bumped)
learning:batch      — Fired when batch learning completes (new playbooks, compression stats)
learning:maintenance — Fired when maintenance cycle completes
```

These feed real-time updates to the learning dashboard via existing WS infrastructure.

**Files to create**:
- `src/api/routes/learning.ts` — Learning API routes
- `src/web/pages/Learning.tsx` — Learning dashboard
- `src/web/pages/LearningPlaybookDetail.tsx` — Playbook detail view
- `src/web/components/learning/` — Dashboard components

### 4. Cross-Hive Knowledge Sync

**Goal**: Federate playbooks and knowledge across hive instances.

#### Sync Units

| Artifact | Sync format | Sync mechanism |
|----------|-------------|----------------|
| Playbooks | JSON (Playbook schema) | `resource_published` / `resource_synced` events via mesh sync |
| Knowledge notes | Markdown + YAML frontmatter | `resource_synced` events (file-level changes) |
| Skills (derived) | skill-tree format | Already syncable as `skill` resources |
| Experiences | Not synced (too voluminous, instance-specific) |
| Meta-learning | Not synced (instance-specific routing optimization) |

#### New Resource Type: `playbook`

Extend `SyncableResourceType` to include `'playbook'`:

```typescript
type SyncableResourceType = 'memory_bank' | 'task' | 'skill' | 'session' | 'playbook'
```

A hive's playbook library is registered as a syncable resource. When batch learning produces new playbooks, a `resource_synced` event is emitted to the mesh. Peer hives materialize incoming playbooks by merging them into their local Atlas:

```
Hive A: batch learning → new playbook extracted
  → resource_synced event (playbook payload)
  → mesh sync → Hive B receives event
  → materializer imports playbook into Hive B's Atlas
  → playbook available for Hive B's routing
```

**Conflict resolution**: Playbooks have semantic versioning and confidence scores. On import:
- If the playbook is new (no local match by name+domain): import directly
- If a local version exists: merge using higher confidence, union of refinements, keep both evolution histories
- Imported playbooks get `provenance.origin = 'imported'` with source hive ID

#### Knowledge Sync via Memory Bank

Knowledge notes are already markdown files compatible with minimem. They can be synced as a `memory_bank` resource using the existing resource sync infrastructure (git-backed or file-level sync). No special handling needed beyond registering the knowledge bank directory as a syncable resource.

**Files to modify**:
- `src/types.ts` — Add `'playbook'` to SyncableResourceType
- `src/sync/materializer.ts` — Handle playbook materialization
- `src/learning/sync.ts` — Emit sync events on learning output, import remote playbooks
- `src/db/dal/syncable-resources.ts` — Playbook resource CRUD

### 5. Hive-as-Compute for Learning

**Goal**: Distribute batch and maintenance learning across hive instances.

This is the most ambitious integration point. Two modes:

#### 5a. Centralized Learning Hive

One hive is designated as the "learning hive" that runs batch/maintenance cycles for a cluster:

```
Hive A (collector) → trajectories → Hive L (learning hive)
Hive B (collector) → trajectories → Hive L (learning hive)
Hive L: runs batch learning on pooled trajectories
  → publishes playbooks/knowledge back via mesh sync
```

**Implementation**: Hives forward trajectory data to the learning hive via a new MAP extension method (`learning/trajectory.submit`). The learning hive processes them through its Atlas. Results propagate back via normal mesh sync.

#### 5b. Domain-Partitioned Learning

Different hives specialize in different domains:

```
Hive A: learns "deployment" domain playbooks
Hive B: learns "debugging" domain playbooks
Hive C: learns "testing" domain playbooks
All hives: sync playbooks to each other via mesh
```

**Implementation**: Configure domain→hive routing in the learning config. When a trajectory arrives, the hive checks the domain and either processes locally or forwards to the designated domain hive.

#### Compute Coordination Protocol

New MAP extension methods:

```
learning/trajectory.submit    — Forward trajectory to compute hive
learning/batch.request        — Request a hive to run batch learning
learning/batch.result         — Return batch learning results
learning/maintenance.request  — Request maintenance cycle
learning/maintenance.result   — Return maintenance results
learning/stats                — Query a hive's learning stats
```

These use the existing MAP notification pattern (JSON-RPC 2.0 over WebSocket), similar to `trajectory/content.request`/`response`.

**Files to create**:
- `src/learning/compute.ts` — Compute coordination (forward/receive trajectories, batch requests)
- `src/map/learning-handler.ts` — MAP handler for learning/* methods

---

## Data Flow

### End-to-End: Trajectory → Learning → Sync

```
┌─────────────┐    MAP checkpoint     ┌──────────────────────────────┐
│ Agent/Swarm  │ ──────────────────── │ OpenHive                     │
│ (cc-swarm)   │                      │                              │
└─────────────┘                      │  trajectory-handler.ts        │
                                      │    ├─ store checkpoint (DB)   │
                                      │    ├─ broadcast WS event      │
                                      │    └─ queue for learning      │
                                      │                              │
                                      │  ingestion.ts                │
                                      │    ├─ resolve transcript      │
                                      │    ├─ synthesize Trajectory   │
                                      │    └─ atlas.processTrajectory │
                                      │         │                    │
                                      │         ├─ Instant loop      │
                                      │         │  ├─ store experience│
                                      │         │  ├─ bump playbooks │
                                      │         │  ├─ extract knowledge│
                                      │         │  └─ broadcast WS   │
                                      │         │                    │
                                      │         └─ (if triggered)    │
                                      │            Batch learning    │
                                      │            ├─ extract playbooks│
                                      │            ├─ compress memory │
                                      │            ├─ publish skills  │
                                      │            └─ emit sync event │
                                      │                  │           │
                                      │  mesh sync ──────┘           │
                                      │    → peer hives receive      │
                                      │    → materialize playbooks   │
                                      └──────────────────────────────┘
```

### Learning Dashboard Data Flow

```
┌──────────────┐   GET /learning/*   ┌──────────────────┐
│ React UI     │ ◄────────────────── │ learning.ts      │
│ Learning.tsx │                      │ (API routes)     │
│              │   WS learning:*     │                  │
│              │ ◄────────────────── │ atlas.getStats() │
└──────────────┘                      │ memory.query()   │
                                      │ pipeline.getStats│
                                      └──────────────────┘
```

---

## Resource Types

### Playbook Resource

```typescript
interface PlaybookResourceMetadata {
  playbook_count: number;
  domains: string[];
  avg_confidence: number;
  last_batch_at?: string;        // ISO 8601
  source_hive_id?: string;       // if imported
}
```

### Learning Resource (cognitive-core state)

The cognitive-core data directory is not itself a syncable resource — it contains instance-specific state (experiences, meta-learning weights) that shouldn't be federated. Only playbooks and knowledge are sync targets.

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
| GET | `/knowledge/graph` | Knowledge graph edges | Bearer |
| GET | `/experiences` | Recent experiences | Bearer |
| GET | `/experiences/:id` | Experience detail | Bearer |
| GET | `/activity` | Learning event timeline | Bearer |
| POST | `/batch` | Trigger batch learning | Admin |
| POST | `/maintenance` | Trigger maintenance cycle | Admin |
| GET | `/config` | Current learning config | Admin |
| PATCH | `/config` | Update learning config | Admin |
| GET | `/health` | Learning engine health report | Bearer |

### MAP Extension Methods

| Method | Direction | Description |
|--------|-----------|-------------|
| `learning/trajectory.submit` | Hive → Hive | Forward trajectory for remote processing |
| `learning/batch.request` | Hive → Hive | Request batch learning on remote hive |
| `learning/batch.result` | Hive → Hive | Return batch results |
| `learning/stats` | Hive → Hive | Query remote learning stats |

---

## Configuration

```javascript
// openhive.config.js
{
  learning: {
    enabled: true,                    // Master toggle

    // Atlas config passthrough
    atlas: {
      creditStrategy: 'simple',       // 'simple' | 'causal'
      minTrajectories: 5,             // Batch trigger threshold
      maxExperiences: 4,              // Per-query memory limit
      maxContextTokens: 4000,
      embedding: { provider: 'none' },// Default: BM25/text-similarity, no API keys
    },

    // Ingestion behavior
    ingestion: {
      mode: 'hybrid',                // 'eager' | 'deferred' | 'hybrid'
      processOnCheckpoint: true,     // Run instant loop on checkpoint arrival
      processOnSessionClose: true,   // Full trajectory synthesis on session end
    },

    // Knowledge bank
    knowledge: {
      enabled: true,
      minimemAware: true,            // Use minimem for search if available
      registerAsResource: true,      // Auto-register as memory_bank resource
    },

    // Skill publishing
    skills: {
      enabled: true,
      registerAsResource: true,      // Auto-register as skill resource
    },

    // Cross-hive sync
    sync: {
      publishPlaybooks: true,        // Emit sync events for new playbooks
      importPlaybooks: true,         // Materialize incoming playbooks
      conflictStrategy: 'merge',     // 'merge' | 'local-wins' | 'remote-wins'
    },

    // Compute: where batch/maintenance learning runs
    compute: {
      agentBackend: 'swarm',         // 'swarm' | 'local-heuristic'
      preferredSwarmId: null,        // Specific swarm for learning, or null for auto-select
      spawnIfNoneAvailable: true,    // Auto-spawn hosted swarm when no connected swarms
      spawnProvider: 'local',        // 'local' | 'sandboxed' (SwarmManager provider)
    },

    // Distributed compute (cross-hive)
    distributed: {
      mode: 'local',                 // 'local' | 'centralized' | 'domain-partitioned'
      learningHiveUrl: null,         // For centralized mode
      domainRouting: {},             // For domain-partitioned: { domain: hiveUrl }
    },

    // Scheduling
    maintenance: {
      schedule: '0 3 * * *',        // Cron for maintenance cycle (3 AM daily)
      autoRun: true,
    },
  }
}
```

---

## Migration & Rollout

### Phase 1: Foundation (Learning Engine Hosting + Ingestion)

- [ ] Add `cognitive-core` dependency
- [ ] Implement `AtlasManager` (lifecycle, config, shutdown)
- [ ] Implement swarm `AgentBackend` adapter (dispatch learning tasks to connected swarms via MAP, spawn via SwarmManager if none available)
- [ ] Implement trajectory adapter (ACP events → cognitive-core Trajectory)
- [ ] Wire ingestion into trajectory-handler (hybrid mode: instant on checkpoint, full on session close)
- [ ] Add `learning` config section to `openhive.config.js`
- [ ] Basic `/learning/stats` route
- [ ] Auto-register knowledge bank as `memory_bank` resource
- [ ] Auto-register published skills as `skill` resource (skill-tree discovery)

### Phase 2: UI & Observability

- [ ] Learning dashboard page (`/learning`)
- [ ] Playbook list + detail views (observability, not agent-facing)
- [ ] Knowledge notes browser with search
- [ ] Learning activity timeline (instant/batch/maintenance events)
- [ ] WebSocket events (`learning:instant`, `learning:batch`, `learning:maintenance`)
- [ ] Session detail "Learning" tab (what was extracted from this session)
- [ ] Batch/maintenance trigger controls (admin)

### Phase 3: Cross-Hive Sync

- [ ] Add `playbook` resource type to SyncableResourceType
- [ ] Emit `resource_synced` events on skill-tree publish (new playbooks → skills)
- [ ] Materialize incoming playbook/skill resources from peer hives
- [ ] Conflict resolution (merge strategy for duplicate playbooks)
- [ ] Knowledge sync via `memory_bank` resource (existing infrastructure)

### Phase 4: Distributed Compute

- [ ] MAP `learning/*` extension methods
- [ ] Centralized learning hive mode
- [ ] Domain-partitioned routing
- [ ] Compute health monitoring

### Future: Team Learning (Design Objective)

- [ ] Team trajectory synthesis from correlated sessions (sessionlog + openteams)
- [ ] `atlas.processTeamTrajectory()` integration
- [ ] Team playbook extraction (role composition, handoff patterns)
- [ ] Team skill publishing

### Future: opentasks Enrichment (Design Objective)

- [ ] Task metadata enrichment for trajectories (task description, domain, dependencies from opentasks)
- [ ] Scoped trajectory analysis (task + trajectory combos)
- [ ] Task-level learning insights (effort estimates, playbook suggestions)

---

## Design Decisions

Resolved questions that shape the architecture.

### 1. Embedding provider → Default `none`

Default to `none` (BM25/text-similarity fallback). Users opt into vector search via Atlas config. When minimem is available, it brings its own embedding config for knowledge search. No OpenHive-level global embedding setting needed.

### 2. Batch learning execution → Dispatch to connected/hosted swarms

Batch learning does **not** run inline on the hive server. cognitive-core's workspace templates are structured to use agents in agent workspaces. OpenHive dispatches batch learning work to connected or hosted swarms — the hive acts as orchestrator, agents do the LLM-heavy analysis.

This means:
- The hive's `AtlasManager` configures cognitive-core with an `AgentBackend` that routes to a connected swarm (via MAP) or a hosted swarm (via SwarmManager)
- Swarm resolution: preferred swarm → LRU among connected → spawn ephemeral hosted swarm (see Decision #8)
- Batch learning triggers spawn a learning task on the resolved swarm
- The swarm's agent executes the workspace template and returns results
- Heuristic-only extraction (no LLM) still runs locally as a fallback when `agentBackend: 'local-heuristic'`

### 3. Team learning → Deferred (design objective)

Included as a design objective but deferred past Phase 4. Team learning requires `TeamTrajectory` synthesis from correlated individual sessions. The data source will be sessionlog with openteams topology information — tracking role attribution, handoff patterns, and team composition across sessions.

**Prerequisites**: Stable single-agent learning pipeline, openteams integration in sessionlog, team trajectory synthesis adapter.

### 4. Playbook manifestation → skill-tree

Playbooks manifest as **skills** published via skill-tree's `SkillPublisher` → `SqliteStorageAdapter`. Agents load them through skill-tree's standard discovery mechanism (`.skilltree/` directory). OpenHive already discovers and serves skill-tree content via resource-content routes.

This means:
- No custom playbook injection protocol needed
- No routing layer intercepting tasks
- Agents get playbooks the same way they get any other skill — via skill-tree
- OpenHive's role is to run learning, publish skills, and serve the skill resource
- The `/api/v1/learning/playbooks` routes are for **observability** (inspecting what was learned), not for agent consumption

Flow: `Trajectory → Learning → Playbook → SkillPublisher → skills.db → .skilltree/ → Agent loads via skill-tree`

### 5. opentasks integration → Deferred (design objective)

opentasks provides scoped trajectories for analysis: task + trajectory combos give cognitive-core bounded problem-solving records to learn from. This is a natural fit for trajectory source enrichment — when a trajectory is associated with an opentasks task, the task metadata (description, dependencies, domain) enriches the Trajectory object fed into the learning pipeline.

**Deferred to Phase 3+**. Noted in the trajectory adapter design as a future enrichment source.

### 6. Storage isolation → Fully independent per hive

Each hive's `cognitive-core.db` and knowledge files are fully isolated. Cross-hive sharing happens exclusively through the sync layer (playbooks as skills, knowledge as memory_bank resources). No shared storage mode.

### 7. Retention policy → cognitive-core owns it, config exposed

cognitive-core's temporal compression (hot → warm → cold → evicted) handles retention internally. OpenHive exposes the relevant config knobs (`maxExperiences`, compression thresholds) through the `learning.atlas` config section but does **not** add hive-level retention policies on top. The two systems remain independent.

---

### 8. Swarm selection for batch learning → Delegate or spawn

When batch learning triggers, the hive resolves a swarm for execution:

1. **Preferred swarm** — If `compute.preferredSwarmId` is configured and online, use it
2. **Least-recently-used** — Among connected swarms, pick the one least recently used for learning
3. **Spawn hosted swarm** — If no connected swarms are available, spawn a temporary hosted swarm via SwarmManager, run the batch, tear it down

This makes learning self-sufficient — a hive with no persistent swarms can still run batch learning by spinning up ephemeral compute. The spawn path uses existing SwarmManager infrastructure (local or sandboxed providers).

Config:
```javascript
learning: {
  compute: {
    agentBackend: 'swarm',
    preferredSwarmId: null,
    spawnIfNoneAvailable: true,   // Auto-spawn hosted swarm for learning
    spawnProvider: 'local',       // 'local' | 'sandboxed' (SwarmManager provider)
  }
}
```

### 9. Skill-tree publish frequency → Immediate, configurable via cognitive-core

Publish immediately after each batch run. Batch runs are already infrequent (energy-threshold gated). Only locally-extracted playbooks are published — imported playbooks from peer hives are not re-published (prevents echo/amplification in the mesh).

Publish behavior is configurable through cognitive-core's `skillTree` config (publish thresholds, confidence gates). OpenHive passes this through via `learning.atlas.skillTree` rather than adding its own publish frequency knob.

### 10. Knowledge graph UI → Deferred

Start with list + search for knowledge notes in Phase 2. Interactive graph visualization deferred — the list view covers the primary use case (browsing and searching learned knowledge). Graph visualization can be revisited when there's concrete user demand.

---

## Open Questions

_No unresolved questions at this time. New questions will be added as implementation progresses._

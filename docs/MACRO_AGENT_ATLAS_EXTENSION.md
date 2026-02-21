# Macro-Agent Atlas Extension: Design Doc

## Summary

Add an optional cognitive-core (Atlas) extension to the macro-agent, enabling learning capabilities — trajectory ingestion, playbook extraction, experience pruning, team learning — within openhive-managed swarms. When enabled via `adapter_config`, the macro-agent initializes an Atlas instance, emits session completion notifications via MAP, and handles cognitive operation commands from openhive.

## Background

**cognitive-core** ([`references/cognitive-core/`](https://github.com/alexngai/cognitive-core)) provides an `Atlas` class that:
- Ingests ReAct-format trajectories (thought → action → observation steps)
- Stores them in an `ExperienceMemory` for retrieval
- Extracts playbooks/skills via `LearningPipeline.runBatchLearning()`
- Prunes stale experiences via `experiences.prune()`
- Runs team learning via `TeamLearningPipeline`
- Queries accumulated knowledge via `memory.queryV2()`
- Supports both heuristic (no LLM) and agentic (LLM-assisted) analysis modes

**openhive** manages swarm lifecycle, syncs resources (memory banks, skill repos) via the MAP protocol, and wants to use cognitive-core's capabilities by hosting a dedicated macro-agent swarm with Atlas enabled.

**What openhive handles (not your concern):**
- Collecting `session.complete` from worker swarms and syncing trajectory data to the cognitive-ops swarm
- Triggering cognitive operations via the API
- Job tracking, lifecycle management, knowledge injection into new worker swarms
- Storing results as syncable resources

**What macro-agent needs to add:**
- Optional Atlas initialization
- ACP → ReAct trajectory conversion + `session.complete` emission
- `cognitive.command` / `cognitive.result` MAP extension handling

## Scope of Changes

### 1. Optional Atlas Initialization

When `adapter_config.atlas.enabled` is true, the macro-agent should initialize a cognitive-core Atlas instance during startup.

**Bootstrap token config (received via `OPENSWARM_BOOTSTRAP_TOKEN`):**

```typescript
{
  adapter: 'macro-agent',
  adapter_config: {
    atlas: {
      enabled: true,
      analysisMode: 'heuristic' | 'agentic',  // default: 'heuristic'
      memory: {
        maxExperiences: 1000,        // default: 1000, 0 = unlimited
        maxExperienceAgeDays: 0,     // default: 0 (unlimited)
        preserveDomainCoverage: true,
      },
    },
    // ... other existing macro-agent config
  },
}
```

**Atlas initialization (pseudo-code):**

```typescript
import { Atlas } from 'cognitive-core';

// In MacroAgentAdapter.initialize() or equivalent:
if (config.atlas?.enabled) {
  this.atlas = await Atlas.create({
    workDir: path.join(workingDir, '.atlas'),
    learning: {
      // Disable auto-batch — openhive triggers manually
      minTrajectories: Infinity,
    },
    teamLearning: {
      enabled: true,
      minTeamTrajectories: Infinity,
    },
    memory: config.atlas.memory,
    analysis: {
      mode: config.atlas.analysisMode ?? 'heuristic',
    },
  });
}
```

Key: Set `minTrajectories: Infinity` to disable auto-batch triggering. All batch operations are triggered explicitly by openhive via MAP commands.

**cognitive-core becomes an optional dependency of macro-agent.** If Atlas is not enabled, it should not be imported (dynamic import or optional peer dependency).

### 2. ACP → ReAct Trajectory Conversion

When a session completes, the macro-agent needs to convert its ACP event stream into cognitive-core's ReAct trajectory format.

**ACP events** (what macro-agent has):
```typescript
// Simplified — macro-agent's event store captures these
{ type: 'message', role: 'user', content: '...' }
{ type: 'message', role: 'assistant', content: '...' }
{ type: 'tool_call', name: 'search', input: {...} }
{ type: 'tool_result', name: 'search', output: {...} }
```

**ReAct trajectory** (what cognitive-core expects):
```typescript
interface Trajectory {
  id: string;
  task: {
    description: string;
    context?: Record<string, unknown>;
    domain?: string;
  };
  steps: TrajectoryStep[];
  outcome: {
    success: boolean;
    result?: string;
    error?: string;
  };
  agentId?: string;
  wallTimeSeconds?: number;
  llmCalls?: number;
}

interface TrajectoryStep {
  type: 'thought' | 'action' | 'observation';
  content: string;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}
```

**Conversion mapping:**
| ACP Event | → | ReAct Step |
|-----------|---|------------|
| `message` (role: assistant, reasoning/planning) | → | `thought` |
| `tool_call` | → | `action` (content = tool name + input) |
| `tool_result` | → | `observation` (content = tool output) |
| `message` (role: assistant, final answer) | → | `thought` (conclusion) |

The conversion function should live in the macro-agent codebase since it's closest to the ACP data structures. A reference implementation exists in cognitive-core at `references/cognitive-core/src/trajectory/` for the trajectory types.

### 3. session.complete MAP Extension

After a session lifecycle ends (all agents done, task completed/failed), emit a JSON-RPC 2.0 notification via MAP:

```typescript
{
  jsonrpc: '2.0',
  method: 'x-openhive/session.complete',
  params: {
    session_id: string,       // macro-agent session ID
    resource_id: string,      // git-backed resource ID where trajectory is stored
    agent_id: string,         // primary agent that ran the session
    swarm_id: string,         // this swarm's ID (from bootstrap token)
    commit_hash: string,      // git commit with trajectory data
    summary: {
      message_count: number,
      tool_call_count: number,
      outcome: 'success' | 'failure' | 'partial',
      duration_ms: number,
    },
    timestamp: string,        // ISO 8601
  }
}
```

**When to emit:**
- After a macro-agent session reaches a terminal state (completed, failed)
- After the ACP → trajectory conversion and git persistence are done
- Only when connected to an openhive MAP hub (check bootstrap token presence)

**Wire format types** are published in [`openhive-types`](https://www.npmjs.com/package/openhive-types) (npm). The `session.complete` types will be added in the next release. For now, the interface above is the contract.

### 4. cognitive.command MAP Extension

When Atlas is enabled, the macro-agent should handle incoming `cognitive.command` messages:

```typescript
// Incoming MAP message
{
  jsonrpc: '2.0',
  method: 'x-openhive/cognitive.command',
  params: {
    operation: 'extract' | 'prune' | 'team-extract' | 'query',
    config: { /* operation-specific */ },
    job_id: string,
  }
}
```

**Dispatch logic:**

```typescript
async function handleCognitiveCommand(params: CognitiveCommandParams): Promise<void> {
  const { operation, config, job_id } = params;

  try {
    let result: Record<string, unknown>;
    let metrics: Record<string, unknown> = {};

    switch (operation) {
      case 'extract': {
        // Run batch playbook extraction on accumulated trajectories
        const extracted = await atlas.learning.runBatchLearning();
        result = { playbooks_count: extracted.length };
        metrics = { playbooks_extracted: extracted.length };
        // If playbooks were produced, persist to git and emit skill.sync
        if (extracted.length > 0) {
          const commitHash = await persistPlaybooksToGit(extracted);
          emitMapNotification('x-openhive/skill.sync', {
            resource_id: skillResourceId,
            agent_id: selfAgentId,
            commit_hash: commitHash,
            timestamp: new Date().toISOString(),
          });
        }
        break;
      }

      case 'prune': {
        // Prune experiences based on provided config
        const pruned = await atlas.memory.experiences.prune({
          maxCount: config.max_experiences,
          maxAgeDays: config.max_age_days,
        });
        result = { experiences_pruned: pruned };
        metrics = { experiences_pruned: pruned };
        // Emit memory.sync if significant changes
        if (pruned > 0) {
          emitMapNotification('x-openhive/memory.sync', { ... });
        }
        break;
      }

      case 'team-extract': {
        const extracted = await atlas.teamLearning.runBatchLearning();
        result = { team_playbooks_count: extracted.length };
        metrics = { playbooks_extracted: extracted.length };
        if (extracted.length > 0) {
          // persist + emit skill.sync
        }
        break;
      }

      case 'query': {
        const queryResult = await atlas.memory.queryV2(
          config.task_description as string,
          { domains: config.domains as string[] }
        );
        result = {
          playbooks: queryResult.playbooks,
          experiences: queryResult.experiences,
        };
        break;
      }
    }

    // Emit success result
    emitMapNotification('x-openhive/cognitive.result', {
      job_id,
      operation,
      status: 'completed',
      result,
      metrics: { ...metrics, duration_ms: elapsed },
    });

  } catch (error) {
    // Emit failure result
    emitMapNotification('x-openhive/cognitive.result', {
      job_id,
      operation,
      status: 'failed',
      error: error.message,
    });
  }
}
```

**When Atlas is NOT enabled:** Ignore `cognitive.command` messages silently (or respond with a `failed` result indicating Atlas is not configured).

### 5. Trajectory Ingestion (Receiving Synced Data)

openhive syncs trajectory data to the cognitive-ops swarm. When the macro-agent receives trajectory data (via resource sync or a dedicated MAP message), it should feed it to Atlas:

```typescript
// When trajectory data arrives from openhive
async function ingestTrajectory(trajectory: Trajectory): Promise<void> {
  if (!this.atlas) return;
  await this.atlas.processTrajectory(trajectory);
}
```

The exact mechanism for receiving synced trajectories will depend on how openhive implements the data brokering (resource sync via MAP, or a dedicated push message). This can be coordinated once the MAP extension messages are in place.

## Dependency: cognitive-core

cognitive-core should be an **optional dependency** — only loaded when `atlas.enabled = true`.

```typescript
// Dynamic import to avoid loading when not needed
let Atlas: typeof import('cognitive-core').Atlas;
if (config.atlas?.enabled) {
  const cogCore = await import('cognitive-core');
  Atlas = cogCore.Atlas;
}
```

**Key cognitive-core APIs used:**

| API | Purpose |
|-----|---------|
| `Atlas.create(config)` | Initialize Atlas with config |
| `atlas.processTrajectory(trajectory)` | Ingest a single trajectory |
| `atlas.learning.runBatchLearning()` | Extract playbooks from accumulated trajectories |
| `atlas.teamLearning.runBatchLearning()` | Extract team playbooks |
| `atlas.memory.experiences.prune(config)` | Prune old/redundant experiences |
| `atlas.memory.queryV2(query, options)` | Query for matching playbooks/experiences |
| `atlas.close()` | Graceful shutdown (flushes state) |

## Shared Types (openhive-types)

Wire format types will be published in `openhive-types` on npm. Install as a dev/peer dependency for type-checking:

```
npm install openhive-types
```

Types to be added:
- `MapSessionCompleteParams` — session.complete message params
- `CognitiveCommandParams` — cognitive.command message params
- `CognitiveResultParams` — cognitive.result message params
- `CognitiveOperation` — `'extract' | 'prune' | 'team-extract' | 'query'`

## Summary of Changes

| Area | Change | Effort |
|------|--------|--------|
| **Config** | Read `adapter_config.atlas` from bootstrap token | Small |
| **Init** | Conditionally initialize Atlas instance | Small |
| **Conversion** | ACP → ReAct trajectory conversion function | Medium |
| **MAP: session.complete** | Emit notification after session ends | Medium |
| **MAP: cognitive.command** | Handle incoming commands, dispatch to Atlas | Medium |
| **MAP: cognitive.result** | Emit results after operations complete | Small |
| **MAP: skill.sync / memory.sync** | Emit after extract/prune produce output | Small (reuse existing sync emission) |
| **Dependency** | Optional `cognitive-core` import | Small |
| **Shutdown** | Call `atlas.close()` on adapter stop | Small |

## Open Questions for Macro-Agent Team

1. **Session lifecycle detection:** What's the current mechanism for detecting session completion in macro-agent? Is there an existing hook/event we can attach to for triggering the ACP→trajectory conversion + session.complete emission?

2. **Git persistence:** Does macro-agent already persist session data to git? If so, can we reuse that for trajectory storage, or does the ReAct format need its own resource?

3. **MAP message emission:** What's the current API for emitting MAP notifications from the adapter? Is it via the `createCombinedServer()` WebSocket, or is there a higher-level API?

4. **Trajectory ingestion mechanism:** How should the cognitive-ops macro-agent receive trajectory data synced by openhive? Options: (a) openhive pushes via a MAP message, (b) macro-agent reads from a synced git resource, (c) a new MAP extension for data push.

# OpenHive

A self-hostable synchronization hub and coordination plane for agent swarms.

## Architecture

Single Fastify server (TypeScript) with several functional layers:

- **MAP Hub**: swarm registration, node discovery, peer coordination, pre-auth keys. *Hives* are namespace/tenancy tags for swarm grouping (not social communities — the legacy community surface was removed).
- **Chat + Mail (Threads)**: unified surface for live ACP sessions, async mail threads, and autonomous agent trajectories. One list, one detail page, one set of rendering components across all flavors.
- **Work pipeline**: specs → dispatches → tasks. An orchestrator polls `dispatches` and routes to agents via ACP or mail.
- **Cross-instance sync**: pull-based mesh protocol (JSON-RPC 2.0) for federating **resources** (memory banks, skills, sessions, repos) and **coordination messages** across instances.

Additional systems: swarm hosting (spawn/manage SwarmRunner processes), session trajectories (on-demand transcript serving from connected agents), platform bridges (Slack, Discord — inbound path currently no-op after social layer removal; outbound infra retained), mesh networking (Tailscale/Headscale).

## Tech Stack

- **Server**: Fastify + TypeScript, tsup build
- **Database**: SQLite (default, better-sqlite3) or PostgreSQL (pg)
- **Frontend**: React + Vite + Tailwind CSS + React Router
- **Real-time**: WebSocket (Fastify WebSocket plugin)
- **CLI**: Commander.js
- **Validation**: Zod schemas
- **Auth**: JWT (jose), bcrypt, local or SwarmHub OAuth

## Source Structure

```
src/
├── api/routes/        # HTTP route handlers (agents, hives, map, sync, sessions, mail, specs, dispatches, events, repos, etc.)
├── api/schemas/       # Zod request/response schemas
├── api/middleware/    # Auth, logging, rate limiting
├── db/dal/            # Data access layer (one file per entity)
├── db/adapters/       # SQLite and PostgreSQL drivers
├── db/schema.ts       # SQL migrations
├── map/               # MAP Hub: swarm registry, agents, repos, trajectories — see src/map/CLAUDE.md
├── sessions/          # Session storage + trajectory architecture — see src/sessions/CLAUDE.md
├── sync/              # Mesh sync: service, materializer, gossip, crypto
├── swarm/             # Swarm hosting: manager, providers (local, sandboxed)
├── coordination/      # Task event relay between swarms — see src/coordination/CLAUDE.md
├── cascade/           # Cascade ↔ task binding (post-merge orchestration) — see src/cascade/CLAUDE.md
├── dispatch/          # swarm-dispatch integration — see src/dispatch/CLAUDE.md
├── scheduler/         # swarm-dispatch scheduler integration (cron-style recurring dispatches) — see src/scheduler/CLAUDE.md
├── swarmkit/          # SwarmKit config proxy + git-sync — see src/swarmkit/CLAUDE.md
├── swarmcraft/        # SwarmCraft plugin integration — see src/swarmcraft/CLAUDE.md
├── realtime/          # WebSocket fan-out helpers — see src/realtime/CLAUDE.md
├── bridge/            # Platform bridges (Slack, Discord adapters)
├── network/           # Mesh networking (Tailscale, Headscale providers)
├── terminal/          # PTY tunneling to hosted swarms
├── events/            # Event normalization and routing
├── swarmhub/          # SwarmHub integration (connector, client, routes)
├── web/               # React frontend (pages, components, hooks, stores, adapters) — see src/web/CLAUDE.md
├── server.ts          # Fastify server setup and plugin registration
├── config.ts          # Configuration loading with Zod validation
├── cli.ts             # CLI commands (init, serve, admin, db, network)
├── skill.ts           # Auto-generated skill.md for agent consumption
└── index.ts           # Library exports (createHive, etc.)
```

## Key Patterns

- **DAL pattern**: All database access goes through `src/db/dal/` files. Never write raw SQL in route handlers.
- **Zod schemas**: Request validation schemas live in `src/api/schemas/`. Response types are inferred from schemas.
- **Config loading**: `src/config.ts` validates all config with Zod. Access config via the validated object, not raw env vars.
- **Event-driven**: State changes emit events through `src/events/dispatch.ts`. WebSocket and sync both consume these events.
- **Pluggable providers**: Network providers (Tailscale, Headscale) and swarm providers (local, sandboxed) follow a common interface pattern in their respective directories.
- **Agent capabilities**: Connected agents declare capabilities during MAP registration using the MAP `ParticipantCapabilities` schema. The hub captures these via the `agent.registered` event and stores on the connection + database. Capability checks gate operations (content requests, chat modes). See `src/web/CLAUDE.md` for capability-gated chat mode mapping.

## Subsystem documentation

Each major subsystem has its own `CLAUDE.md` next to the code that owns it. Claude Code auto-loads these when working on files in that directory.

| Subsystem | Doc | Covers |
|---|---|---|
| MAP Hub | [`src/map/CLAUDE.md`](src/map/CLAUDE.md) | Swarm lifecycle, agent presence vs state, repos + workspaces (federated syncable resources + per-agent bindings), capability declaration |
| Sessions + trajectories | [`src/sessions/CLAUDE.md`](src/sessions/CLAUDE.md) | Trajectory checkpoint flow, 5-tier content resolution, MAP SDK extensions |
| Task coordination | [`src/coordination/CLAUDE.md`](src/coordination/CLAUDE.md) | Hub-as-relay model; agent-side daemon owns task state |
| Cascade ↔ task binding | [`src/cascade/CLAUDE.md`](src/cascade/CLAUDE.md) | Post-merge auto-close orchestration with three-scope policy chain |
| Dispatch orchestrator | [`src/dispatch/CLAUDE.md`](src/dispatch/CLAUDE.md) | swarm-dispatch adapters, status lifecycle, kill switch, V47–V49 persistence |
| Scheduler | [`src/scheduler/CLAUDE.md`](src/scheduler/CLAUDE.md) | swarm-dispatch scheduler integration: cron-style recurring dispatches, payload-types, fire handler, kill-switch respect |
| SwarmKit config + git-sync | [`src/swarmkit/CLAUDE.md`](src/swarmkit/CLAUDE.md) | Disk-backed config proxy, `settings.local.json` overrides, opentasks git-sync signaling |
| SwarmCraft integration | [`src/swarmcraft/CLAUDE.md`](src/swarmcraft/CLAUDE.md) | Agent projection ownership + MAP client ownership |
| Realtime fan-out | [`src/realtime/CLAUDE.md`](src/realtime/CLAUDE.md) | Server-side broadcast helpers + frontend HMR-safe WS client |
| Frontend (chat surfaces) | [`src/web/CLAUDE.md`](src/web/CLAUDE.md) | Unified chat contract across Sessions / Messages / Agent / SwarmDetail; multi-tab session sharing |

## Development

```bash
npm run dev          # API server in watch mode (port 7836)
npm run dev:web      # Vite dev server (port 5173, proxies to :7836)
npm run test:run     # All server tests
npm run test:web:watch  # React tests in watch mode
npm run build        # Full build (server + web)
npm run typecheck    # TypeScript type check
```

## API Routes

All routes prefixed `/api/v1`. Auth via `Authorization: Bearer <api_key>`. Admin routes require `X-Admin-Key`.

Core route groups: agents, hives (namespace), map (swarms, nodes, peers, preauth-keys), resources, repos, swarms (hosting), coordination, sessions (events, chat, checkpoints), mail (conversations, turns), specs, dispatches, schedules, events (subscriptions, delivery-log), admin.

Sync routes at `/sync/v1` (JSON-RPC 2.0). WebSocket at `/ws`. Discovery at `/.well-known/openhive.json` and `/skill.md`.

## Database

SQLite by default (single file at configured path). PostgreSQL supported via connection string. Migrations run automatically on startup via `src/db/schema.ts`. The `openhive db migrate` CLI command runs them manually.

## Configuration

Primary config file: `openhive.config.js`. Key sections: port, host, database, instance identity, auth mode, admin key, rate limiting, sync (peers, discovery), swarm hosting (providers, credentials, sandbox), MAP hub, storage (local/S3), network provider.

Environment variables override config file values. See README for the full env var table.

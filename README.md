# OpenHive

[![License: MIT](https://img.shields.io/badge/License-MIT-amber.svg?style=flat-square)](LICENSE)
[![Node: >=18](https://img.shields.io/badge/Node-%3E%3D18-green.svg?style=flat-square)](https://nodejs.org)
[![Version](https://img.shields.io/badge/version-0.1.8-blue.svg?style=flat-square)](package.json)
[![Build](https://img.shields.io/github/actions/workflow/status/alexngai/openhive/ci.yml?branch=main&style=flat-square)](https://github.com/alexngai/openhive/actions)
[![Download macOS](https://img.shields.io/github/v/release/alexngai/openhive?style=flat-square&logo=apple&label=macOS)](https://github.com/alexngai/openhive/releases/latest/download/OpenHive-mac-arm64.dmg)
[![Download Linux](https://img.shields.io/github/v/release/alexngai/openhive?style=flat-square&logo=linux&logoColor=white&label=Linux)](https://github.com/alexngai/openhive/releases/latest/download/OpenHive-linux-x64.AppImage)

**A self-hostable synchronization hub and coordination plane for agent swarms.**

OpenHive gives distributed agent swarms a shared home: a registry where they find each other, a sync protocol so resources stay consistent across instances, a unified chat + mail surface for humans and agents to coordinate, and the ability to host child swarms directly from the server. Run one instance for a single team. Federate many across organizations.

<p align="center">
  <img src="docs/images/streaming-conversation.gif" alt="A live multi-agent conversation streaming into the OpenHive console" width="820">
</p>

## Why OpenHive

Agent swarms on separate machines have no native way to find each other, share state, or coordinate work — so every project reinvents it with hardcoded endpoints, manual sync scripts, and ad-hoc queues. OpenHive is that coordination layer, done once. It rests on four pillars:

- **Discovery** — swarms register their MAP endpoints and look each other up; agents declare capabilities the hub gates on.
- **Sync** — memory banks, skills, tasks, and session trajectories replicate across instances via a pull-based mesh protocol.
- **Chat + mail** — a unified **Threads** surface: ACP for live sessions, mail for async multi-party threads, event subscriptions for webhook→swarm routing.
- **Hosting** — spawn and manage child SwarmRunner instances with health monitoring, credential injection, and optional OS-level sandboxing.

One server. Self-hosted. No vendor lock-in.

## See it

<p align="center">
  <img src="docs/images/overview-graph.jpg" alt="OpenHive's Overview console — the live codebase graph (5,551 nodes, 16,518 edges) with hub stats and three swarms online" width="100%">
  <br>
  <em>The <strong>Overview</strong> — one live, searchable graph of every swarm, session, skill, and repo the hub is tracking.</em>
</p>

|  |  |
|---|---|
| **Fleet** — every swarm, live presence, agents | **Threads** — chat, mail, and autonomous runs in one place |
| [![Swarms](docs/images/swarms.png)](docs/guide/swarms-and-threads.md) | [![Threads](docs/images/thread-detail.png)](docs/guide/swarms-and-threads.md) |
| **Work** — the task graph, dispatched to swarms | **Library** — compose teams, roles, and skills |
| [![Task graph & dispatch](docs/images/task-graph-dispatch.gif)](docs/guide/work-pipeline.md) | [![Team & skill configs](docs/images/team-skill-configs.gif)](docs/guide/library.md) |

**→ The full walkthrough is in the [User Guide](docs/guide/README.md).**

## Quick Start

```bash
npm install -g openhive
openhive init          # interactive setup: data dir, auth mode, trust model, admin key
openhive serve         # → http://127.0.0.1:7836  (binds to localhost by default)

curl http://127.0.0.1:7836/health
# => {"status":"ok"}
```

The hub serves a built-in React **console** at the root URL — open it in your browser to register swarms, watch threads, and drive the work pipeline. Docker images and a compose file are in **[Deployment](docs/DEPLOYMENT.md)**.

**→ Secure setup, configuration, the full CLI, and deployment live in [docs/](docs/) and [docs/reference/](docs/reference/).**

## Documentation

| | |
|---|---|
| **[User Guide](docs/guide/README.md)** | Getting started, the console, swarms & threads, the work pipeline, the library, federation |
| **[Configuration](docs/reference/configuration.md)** | `openhive.config.js` sections + environment-variable overrides |
| **[CLI Reference](docs/reference/cli.md)** | Every `openhive` command, admin subcommands, and operator workflows |
| **[Security](docs/reference/security.md)** | Trust model, what's protected out of the box, exposing a hub safely |
| **[Deployment](docs/DEPLOYMENT.md)** · **[Hosting](docs/HOSTING.md)** · **[WebSocket](docs/WEBSOCKET.md)** · **[Local setup](docs/LOCAL_SETUP.md)** | Production, hosted swarms, real-time protocol, dev environment |

## Architecture

OpenHive is a single Fastify server with several functional layers sharing a database and a real-time event bus.

```mermaid
graph TB
    subgraph Clients["Clients"]
        A[Agent Swarm A]
        B[Agent Swarm B]
        H[Human / Browser]
    end

    subgraph OpenHive["OpenHive Server"]
        direction TB

        subgraph MAP["MAP Hub"]
            MR[Swarm Registry]
            ND[Node Discovery]
            PD[Peer List]
            OT[Onboard Tokens]
        end

        subgraph Threads["Chat + Mail"]
            ACP[ACP Sessions]
            ML[Mail Conversations]
            TR[Trajectories]
        end

        subgraph Work["Work Pipeline"]
            SP[Specs]
            DP[Dispatches]
            TK[Tasks]
        end

        subgraph Sync["Cross-Instance Sync"]
            SH[Handshake]
            SPP[Pull / Push]
            GS[Gossip Discovery]
        end

        subgraph Infra["Infrastructure"]
            WS[WebSocket Bus]
            DB[(SQLite / Postgres)]
            NET[Mesh Network<br/>Tailscale / Headscale]
        end

        MAP --> DB
        Threads --> DB
        Work --> DB
        Sync --> DB
        MAP --> WS
        Threads --> WS
    end

    subgraph Hosted["Hosted Swarms"]
        OS1[SwarmRunner 1]
        OS2[SwarmRunner 2]
    end

    subgraph Peers["Peer Instances"]
        P1[OpenHive Instance B]
        P2[OpenHive Instance C]
    end

    A -->|REST + WS| OpenHive
    B -->|REST + WS| OpenHive
    H -->|Browser| OpenHive
    OpenHive -->|spawn + monitor| Hosted
    OpenHive <-->|JSON-RPC 2.0 sync| Peers
    MAP --> NET
```

**MAP Hub** — swarms register with their MAP endpoint; nodes within swarms are tracked individually; onboard tokens bootstrap new swarms. *Hives* are namespace/tenancy tags for grouping, not content.

**Chat + Mail (Threads)** — a unified surface for live ACP streams, async mail threads, and autonomous agent trajectories. Every conversation renders through the same components regardless of transport.

**Work Pipeline** — specs author intent → dispatches hand a spec to swarms → tasks decompose the work. An orchestrator polls dispatches and routes to agents via ACP or mail.

**Cross-instance sync** — a pull-based mesh protocol (JSON-RPC 2.0) that federates **resources** (memory banks, skills, session trajectories) and **coordination messages** across instances. Gossip peer discovery, eventual consistency, per-hive sync groups.

<details>
<summary>Additional capabilities</summary>

- **Swarm hosting**: spawns SwarmRunner processes locally, monitors health, auto-restarts, injects credentials
- **Resource sync**: memory banks, skills, tasks, and sessions from the `minimem` / `skill-tree` / `opentasks` ecosystem
- **Session trajectories**: view agent session transcripts (user messages, assistant responses, tool calls) synced from Claude Code via sessionlog and the MAP trajectory protocol
- **SwarmKit config management**: edit configs for installed packages (`opentasks`, `minimem`, `sessionlog`, `openteams`, …) directly on disk, with machine-specific `settings.local.json` overrides detected automatically
- **Platform bridges**: connect a hive to Slack or Discord
- **Mesh networking**: Tailscale Cloud or self-hosted Headscale for secure inter-swarm L3 connectivity
- **Terminal access**: PTY tunneling to hosted swarms via WebSocket (`/ws/terminal`)

</details>

## Library Usage

OpenHive exports a programmatic API for embedding in other Node.js projects:

```typescript
import { createHive } from 'openhive';

const hive = await createHive({
  port: 7836,
  database: './data/openhive.db',
  instance: { name: 'Embedded Hive', description: 'Agent coordination for my project' },
  auth: { mode: 'local' },
  mapHub: { enabled: true },
});

const address = await hive.start();
console.log(`Hive running at ${address}`);

process.on('SIGTERM', () => hive.stop());
```

## Limitations

- **SQLite concurrency** — SQLite serializes writes; switch to PostgreSQL beyond ~50 concurrent writers.
- **Swarm hosting is local-only** — the `docker` provider is config-only; remote hosting (SSH/Kubernetes) isn't in this release.
- **Sandbox isolation is best on Linux** — bubblewrap on Linux; macOS falls back to seatbelt (weaker); Windows unsupported for sandboxed hosting.
- **Sync is eventually consistent** — no cross-instance event ordering or conflict resolution for concurrent edits.
- **Not ActivityPub** — the sync protocol is OpenHive-specific; no Mastodon/Lemmy interop.
- **No built-in TLS** — deploy behind a reverse proxy (nginx, Caddy, Fly.io, Render) for HTTPS.

## License

MIT

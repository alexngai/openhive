# Getting Started

This page takes you from nothing to a running hub with a connected swarm and the console open in your browser. For exact command syntax and every flag, see the **[CLI reference](../reference/cli.md)**.

## Requirements

- **Node.js 18+** (to run from source), or **Docker** (for a production deployment).
- A working directory for the hub's data (SQLite database, config, task graph). OpenHive picks one automatically; you can override it with `OPENHIVE_HOME`.

## 1. Install and initialize

From source:

```bash
git clone https://github.com/openhive/openhive.git
cd openhive
npm install
npm run build
```

Then run the interactive setup wizard, which writes your config and creates the hub's identity:

```bash
openhive init
```

`init` prompts for the essentials — the data directory, the **auth mode**, the **agent trust model** (default: *verified*), and an admin key. New hubs default to a locked-down posture; see **[Security](../reference/security.md)** for what each choice means.

## 2. Start the hub

```bash
openhive serve
# → listening on http://127.0.0.1:7836
```

The hub binds to `127.0.0.1` by default — it is not reachable from other machines until you opt in. Check it's alive:

```bash
curl http://127.0.0.1:7836/health
# => {"status":"ok"}
```

## 3. Open the console

The web console is a React app served alongside the API. In development:

```bash
npm run dev:web
# → Vite dev server on http://localhost:5173 (proxies API calls to :7836)
```

Open **http://localhost:5173** and you'll land on the **Overview**. The sidebar is grouped into **Fleet**, **Work**, and **Library** — the [next page](the-console.md) tours it.

> **Operator login (self-hosted):** to sign in to the console with a username + password, create an operator account with `openhive admin operator …`. Details in the [CLI reference](../reference/cli.md#operator-login).

## 4. Connect your first swarm

A swarm connects to the hub over the **MAP WebSocket** using a short-lived credential. Mint an onboard token — from the console's **Connect** dialog (Swarms → *Connect*) or the CLI:

```bash
openhive admin onboard-token
# → prints AGENT_TOKEN + MAP_CREDENTIAL for the swarm to use
```

The swarm sets `MAP_CREDENTIAL` in its environment and connects:

```
ws://127.0.0.1:7836/ws/map?swarm_id=<id>&token=<MAP_CREDENTIAL>
```

Once connected, the swarm registers its agents (each declaring capabilities such as ACP chat, mail, or task creation) and appears in **Fleet → Swarms** with live presence.

<p align="center">
  <img src="../images/swarms.png" alt="The Swarms page showing three connected swarms, online, with agent counts" width="820">
</p>

## Where to next

- **[The Console](the-console.md)** — learn your way around the UI.
- **[Swarms & Threads](swarms-and-threads.md)** — talk to agents and follow their work.
- **[The Work Pipeline](work-pipeline.md)** — hand work to swarms and review what comes back.

For headless / production operation (Docker, bootstrap tokens, capability grants, exposing the hub), see **[Security](../reference/security.md)** and **[Deployment](../DEPLOYMENT.md)**.

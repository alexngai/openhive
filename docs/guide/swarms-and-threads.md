# Swarms & Threads

This is the heart of the console: **who is connected** and **what they're saying and doing**.

## Swarms

A **swarm** is a group of agents connected to the hub. **Fleet → Swarms** lists them in two buckets:

- **Hosted** — swarms the hub spawned and manages itself (SwarmRunner processes).
- **Registered** — external swarms that connected inbound over the MAP WebSocket.

<p align="center">
  <img src="../images/swarms.png" alt="Three registered swarms, all online, with agent counts and endpoints" width="880">
</p>

Each card shows the swarm's name and id, its MAP endpoint, an **agent count**, when it was last seen, and a live **presence** badge:

- 🟢 **Online** — connected and reachable.
- 🟠 **Unreachable** — was connected, missed heartbeats; the hub keeps last-known state.
- ⚪ **Offline** — gone; demoted after a staleness window.

Presence is tracked independently of an agent's *work* state. An agent can be `busy` but its swarm still `online`, or `idle` but `unreachable` — the console never conflates "alive" with "currently working."

**Agents** register per-swarm during MAP connection, each declaring its own **capabilities** — ACP streaming chat, mail, task creation, and so on. Those declarations decide how you can interact with the agent (see *Threads* below). Use **Connect** to onboard an external swarm (mint a token) or **Spawn** to launch a hosted one.

## Threads

Sessions, mail, and autonomous runs used to be three separate screens. They're now one **Threads** surface: a single list on the left, a detail view on the right that adapts to the thread's flavor, and the same rendering components across all of them. Filter the list by **All / Live / Mail / Dispatch**.

- **Live (ACP)** — a streaming, bidirectional chat with an agent that declared `protocols: ['acp']`. Full tool-call visibility, permission prompts, stop/cancel.
- **Mail** — an async thread. Agents post turns; you reply on your schedule; delivery happens on the agent's next activation. Great for group coordination across many agents.
- **Dispatch** — the trajectory of an autonomous run kicked off from the work pipeline.

### A live multi-agent conversation

Group threads show every participant, and **each turn carries its own agent's name and avatar** — so a research lead handing tasks to two scouts reads exactly like that, not like one voice:

<p align="center">
  <img src="../images/streaming-conversation.gif" alt="A group thread streaming in, each turn attributed to its agent" width="880">
</p>

The header shows the subject, a `group · N` badge with the participant stack, the live status, and the turn count. The participants strip lists everyone by name and role; where an agent has a linked session, its avatar deep-links into that session's trajectory. New turns stream in on a poll and the view auto-scrolls to the newest.

<p align="center">
  <img src="../images/thread-detail.png" alt="The Threads detail view of a multi-agent research conversation" width="880">
</p>

### Replying

The composer at the bottom adapts to what the thread supports. ACP threads get a live send with streaming and a stop button; mail threads take a turn that's delivered asynchronously (the composer says so). If a conversation is closed or the agent is offline, the composer explains why instead of failing silently. You can **Invite** additional mail-capable agents into a group thread from the header.

---

Next: **[The Work Pipeline](work-pipeline.md)** — hand structured work to these swarms and review what they change.

# src/swarmcraft — SwarmCraft plugin integration

When OpenHive embeds the SwarmCraft plugin, two ownership rules keep the agent-projection and MAP-client surfaces from racing each other.

## Agent projection ownership

OpenHive registers the SwarmCraft plugin with `skipAgentLifecycle: true` (see `src/server.ts`). This suppresses swarmcraft's built-in MAP `agent.registered` / `agent.unregistered` / `agent.state.changed` / `agents.synced` handlers so that **OpenHive's bridge (`src/swarmcraft/swarm-bridge.ts`) is the sole writer of agent rows in the SwarmCraft DB**.

Identity scheme: namespaced ids
- `oh-swarm-{swarmId}` for swarms
- `oh-node-{swarmId}-{mapAgentId}` for child agents

…via `src/swarmcraft/constants.ts`.

Without this flag, swarmcraft's built-in handlers would also write rows using the raw MAP agent id, producing duplicate rows for every logical agent visible on both inbound (sidecar→hub) and outbound (swarmcraft→swarm MAP) connections.

As part of taking over the lifecycle, the bridge also calls `acpStreamManager.closeStreamsForAgent(rawMapAgentId)` on terminal MAP states (`stopped`, `failed`, `orphaned`) and on agent unregister — both for:
- the inbound path (via `mapHubEvents.node_unregistered` / `node_state_changed`)
- the outbound path (via `mapClientManager.on('agent.unregistered' | 'agent.state.changed')`)

Streams are keyed by **raw MAP id** (the `targetAgent` passed at stream creation), never by the projected `oh-node-*` id.

## MAP client ownership

Beyond projection ownership, OpenHive also instantiates the `MAPClientManager` itself (in `src/server.ts`, imported from `swarmcraft/map`) and passes the instance to the SwarmCraft plugin via the `mapClientManager` option. This means:

- **Exactly one outbound MAP client pool exists**.
- OpenHive owns it; SwarmCraft uses it for ACP routing, subprocess wiring, and lifecycle listeners — without spinning up a second.

Combined with `skipAgentLifecycle: true` above, OpenHive is both the sole writer of `sc_agents` rows AND the sole owner of the outbound connections that feed them — no dual-ownership race on teardown, no competing connects on the same swarm.

OpenHive registers an `onClose` hook that calls `disconnectAll()` on the manager; SwarmCraft's `destroySwarmCraftContext` leaves it alone because `ownsMapClientManager` is false. `swarm-bridge.ts` still drives `connect()` / `getClient()` / event listeners exactly as before — the instance is just OpenHive's now, not SC's.

## Key files

- `src/swarmcraft/swarm-bridge.ts` — sole writer of `sc_agents` rows; cascades presence on `swarm_offline` via `bulkUpdatePresenceByServer`.
- `src/swarmcraft/constants.ts` — namespaced-id construction (`oh-swarm-*`, `oh-node-*`).
- `src/server.ts` — registers the plugin with `skipAgentLifecycle: true` + supplies the shared `MAPClientManager` instance + sets up the ACP→global event bridge.
- `src/realtime/acp-bridge.ts` — forwards `acp.*` events from SwarmCraft's `acp` topic to OpenHive's `global` WS channel; `events`-topic broadcasts are skipped to avoid duplicate fan-out.

## Related subsystems

- **Agent presence**: SwarmCraft's `agents` table mirrors `map_nodes.presence`; the bridge cascades on `swarm_offline`. See `src/map/CLAUDE.md` "Agent presence vs state".
- **Chat surfaces**: ACP / mail adapters consumed by openhive's chat UI live in swarmcraft's `ui/embed`. See `src/web/CLAUDE.md` for how openhive constructs its adapter set.

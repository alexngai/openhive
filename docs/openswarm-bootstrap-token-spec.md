# OpenSwarm Bootstrap Token Specification

> **Status**: Request for implementation in [openswarm](https://github.com/alexngai/openswarm)
>
> **Context**: OpenHive can now spawn OpenSwarm instances as managed sidecars. To complete the integration, OpenSwarm needs to support receiving a bootstrap token at startup and using it to self-register with an OpenHive MAP hub.

## Overview

When OpenHive spawns an OpenSwarm instance, it passes a **bootstrap token** containing everything the swarm needs to start and register itself with the OpenHive MAP hub. This enables zero-configuration swarm deployment — the spawned process just reads the token and connects back.

## Token Format

The bootstrap token is a **base64-encoded JSON object** passed via the `OPENSWARM_BOOTSTRAP_TOKEN` environment variable.

```typescript
interface BootstrapToken {
  version: 1;
  /** The OpenHive instance URL to register with */
  openhive_url: string;        // e.g. "http://localhost:3000"
  /** Single-use pre-auth key for MAP hub registration */
  preauth_key: string;         // e.g. "ohpak_abc123..."
  /** Name for the swarm */
  swarm_name: string;
  /** OpenSwarm adapter to use */
  adapter: string;             // e.g. "macro-agent"
  /** Adapter-specific configuration */
  adapter_config?: Record<string, unknown>;
  /** Extra metadata to attach to the swarm registration */
  metadata?: Record<string, unknown>;
  /** When this token was issued (ISO 8601) */
  issued_at: string;
  /** When this token expires (ISO 8601, typically 1 hour) */
  expires_at: string;
}
```

## Delivery

The token is delivered as an environment variable:

```
OPENSWARM_BOOTSTRAP_TOKEN=eyJ2ZXJzaW9uIjoxLCJvcGVuaGl2ZV91cmwiOiJodHRwOi8v...
```

OpenHive sets this when spawning:
- **Local sidecar**: passed as `env` to `child_process.spawn()`
- **Docker**: passed as `-e OPENSWARM_BOOTSTRAP_TOKEN=...`
- **Remote (Fly, Railway, etc.)**: set as a secret/env var in the deploy config

## Required Behavior in OpenSwarm

### 1. Token Detection (on startup)

In the hosting server startup path (`src/hosting/index.ts` or equivalent), check for the bootstrap token:

```typescript
const bootstrapToken = process.env.OPENSWARM_BOOTSTRAP_TOKEN;
if (bootstrapToken) {
  const token = JSON.parse(Buffer.from(bootstrapToken, 'base64').toString('utf-8'));
  // Validate token.version === 1
  // Check token.expires_at > now
  // Proceed with bootstrap flow
}
```

### 2. Self-Registration with MAP Hub

After the MAP server is healthy, call the OpenHive MAP hub to register:

```typescript
// POST {token.openhive_url}/api/v1/map/swarms
const response = await fetch(`${token.openhive_url}/api/v1/map/swarms`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${agentApiKey}`, // See auth note below
  },
  body: JSON.stringify({
    name: token.swarm_name,
    map_endpoint: `ws://127.0.0.1:${serverPort}`, // or public URL
    map_transport: 'websocket',
    capabilities: {
      observation: true,
      messaging: true,
      lifecycle: true,
    },
    metadata: token.metadata,
    preauth_key: token.preauth_key,
  }),
});
```

### 3. Heartbeat Loop

After registration, start sending heartbeats to stay marked as online:

```typescript
// POST {token.openhive_url}/api/v1/map/swarms/{swarm_id}/heartbeat
setInterval(async () => {
  await fetch(`${token.openhive_url}/api/v1/map/swarms/${swarmId}/heartbeat`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${agentApiKey}` },
  });
}, 60_000); // Every 60 seconds (hub stale threshold is 5 min by default)
```

## Authentication Note

The MAP hub requires agent authentication. Two options:

**Option A (simpler, recommended for v1):** OpenHive's SwarmManager registers the swarm on behalf of the spawned process (already implemented). The spawned OpenSwarm doesn't need to call the registration endpoint itself — it just needs to start serving on the assigned port. OpenHive handles MAP registration after the health check passes.

**Option B (for remote/self-registering swarms):** The bootstrap token includes a pre-auth key. The remote OpenSwarm instance would need to first register as an agent on the OpenHive instance, then use its API key to register the swarm with the pre-auth key. This is the flow for remote deployments where OpenHive can't directly register on behalf of the swarm.

For the local sidecar provider (the initial implementation), **Option A is used** — OpenHive does both the process spawning and the MAP registration. The bootstrap token is still passed for future use and so the swarm knows its configuration.

## What OpenSwarm Needs to Implement

### Minimum (for local sidecar to work today)

Nothing — OpenHive handles MAP registration after health check. OpenSwarm just needs to:
1. Start the MAP server on the port specified by `--port`
2. Respond to health checks on `{port+1}/health`

### For remote/self-registering deployments (future)

1. Read `OPENSWARM_BOOTSTRAP_TOKEN` env var on startup
2. Decode and validate the token
3. After server is healthy, register with the MAP hub using the pre-auth key
4. Start heartbeat loop
5. On shutdown, deregister from the MAP hub

### Suggested File Location

```
src/hosting/bootstrap.ts    # Token parsing, validation, registration logic
```

## Example Flow

```
OpenHive                          OpenSwarm (local sidecar)
   │                                    │
   │  spawn process with               │
   │  OPENSWARM_BOOTSTRAP_TOKEN  ──────▶│
   │                                    │  Start MAP server on :9001
   │                                    │  Start HTTP gateway on :9002
   │  GET :9002/health  ──────────────▶│
   │  ◀──────────────── 200 OK ────────│
   │                                    │
   │  Register swarm in MAP hub         │
   │  (using pre-auth key)              │
   │                                    │
   │  Start heartbeat loop              │
   │  POST :3000/map/swarms/X/heartbeat │
   │  every 60s                         │
   │                                    │
   │  ... swarm is live and             │
   │  discoverable in hives ...         │
   │                                    │
```

## Credential Propagation

The bootstrap token carries **coordination data only** (OpenHive URL, pre-auth key, adapter config) — never secrets like API keys. Runtime credentials (LLM keys, git tokens, tool API keys) are injected separately through the hosting provider's native mechanism.

### How It Works

Credentials are configured in `openhive.config.js` under `swarmHosting.credentials` and resolved at spawn time:

```javascript
swarmHosting: {
  credentials: {
    // Inherit operator's process.env into swarms (default: true for local provider)
    inherit_env: true,

    // Named credential sets — declare which env vars to forward
    sets: {
      'llm-default': {
        source: 'env',  // read from process.env at spawn time
        vars: {
          ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',
          OPENAI_API_KEY: 'OPENAI_API_KEY',
        },
      },
      'cogops': {
        source: 'env',
        vars: { ANTHROPIC_API_KEY: 'COGOPS_ANTHROPIC_KEY' },
      },
    },

    // Default set applied to all swarms
    default_set: 'llm-default',

    // Per-hive overrides for credential isolation
    hive_overrides: {
      'cogops': { credential_set: 'cogops' },
      'my-repo': { extra_vars: { GITHUB_TOKEN: process.env.MY_REPO_TOKEN } },
    },
  },
}
```

### Resolution Order

Credentials are layered (later wins):

1. `process.env` (if `inherit_env: true` — provider handles this)
2. `default_set` credential set
3. Hive-specific override (`credential_set` swap and/or `extra_vars`)
4. Per-spawn `credential_overrides` (passed via API)

### Injection by Provider

| Provider | Mechanism |
|----------|-----------|
| Local | `env` object on `child_process.spawn()` |
| Docker | `--env-file` or `-e` flags |
| Fly/K8s | Platform-native secrets |

### Credential Source Modes

| Mode | Behavior |
|------|----------|
| `static` | Literal values in config (evaluated at config load time) |
| `env` | Values are env var names — read from `process.env` at spawn time |
| `env-fallback` | Use static value if non-empty, otherwise fall back to same-named env var |

The `env` source is recommended — it keeps secrets out of config files entirely. The config declares *which* env vars to forward, actual values come from the operator's environment (shell, `.env` file, CI secrets, etc.).

### DB Safety

Resolved credential values are **never persisted** to the database. Only resolution metadata (which set, which hive) is stored, so credentials can be re-resolved fresh on auto-restart.

## Related

- OpenHive swarm hosting: `src/swarm/` module
- Credential resolver: `src/swarm/credentials.ts`
- MAP hub: `src/map/` module
- HeadscaleManager (pattern reference): `src/headscale/manager.ts`

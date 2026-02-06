# Mesh Networking Setup Spec

## Problem

OpenHive's MAP hub provides L7 swarm discovery (endpoint URLs, agent capabilities, peer lists). But when swarm hosts are personal PCs and cloud VMs behind NATs, they can't reach each other at L3/L4. A WireGuard mesh solves this — but setting it up is non-trivial, especially behind a home NAT.

This spec captures the networking prerequisites, deployment scenarios, and UX for OpenHive's pluggable mesh networking system.

## Implementation Status

The `NetworkProvider` interface (`src/network/types.ts`) abstracts over three backends:

| Provider | Config key | Status |
|----------|-----------|--------|
| **Tailscale Cloud** | `network.provider: 'tailscale-cloud'` | Implemented |
| **Headscale sidecar** | `network.provider: 'headscale-sidecar'` | Implemented |
| **External headscale** | `network.provider: 'headscale-external'` | Implemented |
| **None** | `network.provider: 'none'` (default) | Implemented |

CLI wizard: `openhive network setup` walks through provider selection and configuration.

Legacy `headscale.enabled: true` config is still supported (maps to headscale-sidecar).

---

---

## Architecture Recap

```
┌────────────────────────────────────────────────────┐
│  OpenHive Server                                    │
│                                                     │
│  ┌──────────────┐   ┌──────────────────────────┐   │
│  │  MAP Hub      │   │  Headscale Sidecar        │   │
│  │  (L7 plane)   │   │  (L3/L4 plane)            │   │
│  │               │   │                            │   │
│  │  - swarm reg  │   │  - WireGuard key exchange  │   │
│  │  - peer lists │◄──│  - IP allocation           │   │
│  │  - discovery  │   │  - NAT traversal           │   │
│  │  - pre-auth   │   │  - DERP relay              │   │
│  └──────────────┘   └──────────────────────────┘   │
│       :3000                  :443 (TLS)             │
└────────────────────────────────────────────────────┘
         ▲                        ▲
         │ JSON-RPC/REST          │ Noise protocol (ts2021)
         │                        │
    ┌────┴────┐              ┌────┴─────┐
    │ Swarm A │              │ tailscale│
    │ (MAP)   │              │ client   │
    └─────────┘              └──────────┘
```

The MAP hub and headscale solve different problems and have different network requirements:

| Concern | MAP Hub | Headscale |
|---------|---------|-----------|
| Port | tcp/3000 (HTTP) | tcp/443 (HTTPS, **required**) |
| Protocol | REST / JSON-RPC | Noise IK (ts2021 upgrade) |
| TLS | Optional | **Mandatory** (clients enforce it) |
| Reachability | Only needs to be reached by swarm orchestrators | Must be reached by every host running tailscale |
| UDP | None | udp/3478 (STUN) if embedded DERP |

---

## Hard Requirements

These are non-negotiable for headscale to function:

### 1. HTTPS on port 443 with a valid public certificate

Tailscale clients **refuse to connect** to headscale over plain HTTP or on non-443 ports in recent versions. The certificate must be:
- From a publicly trusted CA (Let's Encrypt, ZeroSSL, etc.)
- **Not** self-signed (Android client rejects incomplete chains)
- Full-chain (leaf + intermediates)
- Matching the `server_url` hostname

Ref: [tailscale/tailscale#15008](https://github.com/tailscale/tailscale/issues/15008) — the ts2021 Noise handshake silently forces TLS for non-localhost hosts.

### 2. A public DNS name

Required for:
- The TLS certificate (Let's Encrypt needs a resolvable hostname)
- The `server_url` config (what tailscale clients connect to)
- Stable identity across IP changes

### 3. tcp/443 reachable from the internet

Every machine running `tailscale up --login-server <url>` must be able to reach this port for the initial key exchange and ongoing map updates (long-poll).

### 4. The headscale binary installed

The manager spawns `headscale serve` as a child process. The binary must be pre-installed and either in `$PATH` or pointed to via `headscale.binaryPath`.

### 5. Tailscale client on every swarm host

Each machine running a MAP swarm needs `tailscale` (the client) installed. After the swarm registers with OpenHive and gets a pre-auth key, the operator runs:
```
tailscale up --login-server https://<server_url> --authkey <KEY>
```

### 6. `base_domain` configured

Headscale needs a base domain for MagicDNS hostnames (e.g., `swarm-a.my-hive.hive.internal`). This:
- **Must differ** from the `server_url` domain
- Can be a made-up domain (e.g., `hive.internal`) — it's only resolved within the tailnet
- Should **not** be a real domain you have DNS records under (MagicDNS will shadow them)

---

## Deployment Scenarios

### Scenario A: Cloud VPS (simplest)

**When**: You have a VPS with a public IP (Hetzner, DigitalOcean, Oracle free tier, etc.)

**Prerequisites**:
1. A domain pointing to the VPS (A record)
2. Ports open: tcp/80 (ACME), tcp/443 (headscale), udp/3478 (STUN, optional)
3. `headscale` binary installed
4. `tailscale` client on each swarm host

**Config**:
```js
{
  headscale: {
    enabled: true,
    serverUrl: "https://openhive.example.com",
    listenAddr: "0.0.0.0:443",
    baseDomain: "hive.internal",
    embeddedDerp: true,  // recommended — your own relay
  }
}
```

**TLS options**:
- **Option 1**: Headscale's built-in Let's Encrypt (`tls_letsencrypt_hostname`)
- **Option 2**: Reverse proxy (Caddy auto-TLS is simplest) in front of headscale on `127.0.0.1:8085`

**Setup complexity**: Low. This is the happy path.

---

### Scenario B: Home PC with a real public IP (no CGNAT)

**When**: Your ISP gives you a real routable IP, but it may change.

**Prerequisites**:
1. Router port forwards: tcp/80 → host, tcp/443 → host, udp/3478 → host
2. Dynamic DNS service (DuckDNS, Cloudflare DDNS, etc.) pointing to your IP
3. `headscale` binary installed on the PC
4. `tailscale` client on each swarm host

**Config**:
```js
{
  headscale: {
    enabled: true,
    serverUrl: "https://my-hive.duckdns.org",
    listenAddr: "0.0.0.0:443",
    baseDomain: "hive.internal",
    embeddedDerp: true,
  }
}
```

**TLS**: Headscale's built-in Let's Encrypt with HTTP-01 challenge (needs tcp/80 forwarded).

**Caveats**:
- STUN port (udp/3478) **must** be forwarded as-is — you cannot remap the external port
- If your IP changes and DDNS hasn't caught up, existing tailscale clients will reconnect once DNS updates (they long-poll, so the disruption is brief)
- Some ISPs block port 80/443 on residential connections — check before committing to this approach

**Setup complexity**: Medium. Port forwarding + DDNS is well-understood but error-prone.

---

### Scenario C: Home PC behind CGNAT (no public IP)

**When**: Your ISP uses Carrier-Grade NAT. You have no real public IP. `curl ifconfig.me` returns an IP you don't control.

**This is the hardest case and the most common for home users.**

**What does NOT work**:
- **Cloudflare Tunnel**: Does not support the ts2021 Noise protocol upgrade. The headscale web UI loads, but tailscale clients cannot register. Do not attempt this.
- **ngrok (free tier)**: Random hostnames on restart break `server_url`. No UDP forwarding for STUN.
- **Tailscale Funnel**: Not implemented in headscale. Chicken-and-egg problem anyway.

**What works**:

#### Option C1: VPS relay (recommended)

Use a cheap VPS ($3-5/mo) as a public entry point. The VPS runs a reverse proxy; a tunnel carries traffic back to your home PC.

```
Internet → VPS:443 (Caddy) → WireGuard tunnel → Home PC:8085 (headscale)
```

Prerequisites:
1. A cheap VPS with a public IP
2. A domain pointing to the VPS
3. WireGuard (or SSH) tunnel from home → VPS
4. Caddy/nginx on VPS reverse-proxying tcp/443 to the tunnel
5. Headscale on home PC listening on a local port
6. STUN: either skip embedded DERP (use Tailscale's public DERP) or forward udp/3478 through the VPS

Config on the home PC:
```js
{
  headscale: {
    enabled: true,
    serverUrl: "https://openhive.example.com",  // the VPS domain
    listenAddr: "127.0.0.1:8085",               // local only, tunnel handles the rest
    baseDomain: "hive.internal",
    embeddedDerp: false,                         // use public DERP, simpler
  }
}
```

#### Option C2: Tunneling tools (rathole, frp, bore, Pangolin)

Same idea as C1 but using a purpose-built tunneling tool instead of WireGuard:

```bash
# On VPS:
rathole --server --bind 0.0.0.0:443 --remote 127.0.0.1:8085

# On home PC:
rathole --client --server vps.example.com:443 --local 127.0.0.1:8085
```

These tools are lighter than WireGuard but require a VPS either way.

**Setup complexity**: High. Requires managing a VPS, tunnel, reverse proxy, and TLS termination.

---

### Scenario D: Headscale hosted externally (not sidecar)

**When**: You already run headscale somewhere, or you want to separate the control plane from OpenHive.

In this mode, OpenHive doesn't manage the headscale process. Instead, it connects to an existing headscale instance via its REST API.

**Prerequisites**:
1. A running headscale instance (self-managed or hosted service)
2. An API key for that instance
3. Network connectivity from OpenHive to the headscale API

**Config**:
```js
{
  headscale: {
    enabled: false,  // don't manage the binary
    // Instead, configure the client directly:
    // (not yet implemented — see Future Work below)
  }
}
```

**This scenario is not yet supported** by the current implementation, which only handles the sidecar case. See Future Work.

---

## Port Summary

| Port | Protocol | Scenario A (VPS) | Scenario B (home, public IP) | Scenario C (CGNAT) |
|------|----------|-------------------|-------------------------------|---------------------|
| tcp/443 | Headscale control + DERP | Open on VPS | Port forward from router | Tunneled via VPS |
| tcp/80 | ACME (Let's Encrypt) | Open on VPS | Port forward from router | On VPS (Caddy handles it) |
| udp/3478 | STUN | Open on VPS | Port forward (**same port**) | Skip (use public DERP) |
| tcp/3000 | OpenHive API | Open or proxied | LAN only (or port forward) | LAN only (or tunnel) |
| tcp/8085 | Headscale API (internal) | localhost only | localhost only | localhost only |

---

## TLS Termination Decision Tree

```
Do you have a reverse proxy (Caddy/nginx) in front?
├── Yes → Let the proxy handle TLS. Headscale listens on HTTP internally.
│         Caddy: automatic HTTPS. Nginx: certbot + cron renewal.
│         headscale listenAddr = "127.0.0.1:8085"
│
└── No → Does headscale listen directly on :443?
          ├── Yes → Use headscale's built-in Let's Encrypt:
          │         tls_letsencrypt_hostname: "your.domain.com"
          │         tls_letsencrypt_challenge_type: "HTTP-01"
          │         (needs tcp/80 open for ACME validation)
          │
          └── No → You need to manually provide cert + key:
                    tls_cert_path: "/path/to/fullchain.pem"
                    tls_key_path: "/path/to/privkey.pem"
```

---

## Current Implementation Gaps

Things the current code does **not** handle that this spec identifies as necessary:

### 1. No TLS termination

`headscale/config.ts` generates a config that listens on plain HTTP. The generated `headscale.yaml` lacks `tls_cert_path`, `tls_key_path`, and `tls_letsencrypt_*` fields.

**Needed**: Add TLS config options to `HeadscaleSidecarOptions` and `config.ts`:
```typescript
headscale: {
  // ... existing fields ...
  tls: {
    mode: 'none' | 'letsencrypt' | 'manual' | 'reverse-proxy',
    letsencryptHostname?: string,
    certPath?: string,
    keyPath?: string,
  }
}
```

### 2. `getServerUrl()` returns a placeholder

`sync.ts:262` returns `'(your-headscale-server-url)'` instead of the configured URL. The `HeadscaleSync` constructor receives `baseDomain` but not `serverUrl`.

**Needed**: Pass `serverUrl` into `HeadscaleSync` and use it in provisioning instructions.

### 3. No external headscale mode

The current implementation only supports running headscale as a managed child process. There's no way to point OpenHive at an existing headscale instance.

**Needed**: A `HeadscaleClient`-only mode where OpenHive connects to an external headscale via API key + URL, without managing the process.

### 4. No auto-download of headscale binary

The manager fails immediately if the binary isn't found. Users must install it manually.

**Needed**: Either auto-download from GitHub releases on first run, or at minimum a clear error message with install instructions and a link.

### 5. Embedded DERP needs public IP config

When running embedded DERP behind NAT, headscale needs to know the public IP to advertise to clients:
```yaml
derp:
  server:
    ipv4: <PUBLIC_IP>
```

The current config generator doesn't set `ipv4`/`ipv6` on the DERP server block.

**Needed**: Auto-detect public IP (via STUN or `https://ifconfig.me`) or accept it as config.

### 6. No ACL sync on hive creation

`syncAclPolicy()` exists in `sync.ts` but is never called. New hives don't automatically get network isolation rules.

**Needed**: Wire `syncAclPolicy()` into the hive creation and swarm join/leave flows.

### 7. No connectivity validation

There's no way to check that headscale is actually reachable from the internet before telling a user to run `tailscale up`.

**Needed**: A `POST /map/network/check` endpoint or CLI command that verifies external reachability of the headscale port.

### 8. No setup wizard / guided onboarding

The current setup requires manually editing config files. For the CGNAT case especially, this is a multi-step process that's easy to get wrong.

**Needed**: An interactive CLI flow and/or web-based setup wizard (see UX section below).

---

## UX Improvements (Future Work)

### Phase 1: Better defaults and error messages

- [ ] Detect missing headscale binary on startup → print install instructions with platform-specific commands and a download URL
- [ ] Detect CGNAT on startup (compare local IP to `ifconfig.me`) → warn user and suggest VPS relay approach
- [ ] Validate `serverUrl` is HTTPS → error if HTTP
- [ ] Test external reachability of headscale port on startup → warn if unreachable
- [ ] Fix `getServerUrl()` placeholder
- [ ] Add TLS fields to config generator

### Phase 2: `openhive network setup` CLI wizard

An interactive command that walks the user through headscale setup:

```
$ openhive network setup

  OpenHive Network Setup
  ━━━━━━━━━━━━━━━━━━━━━

  This wizard will set up mesh networking so swarm hosts can
  reach each other, even behind NATs.

  Checking prerequisites...
  ✓ headscale binary found (v0.28.2)
  ✗ tailscale not found (needed on swarm hosts, not this server)

  Detecting network environment...
  • Local IP: 192.168.1.42
  • Public IP: 203.0.113.5
  • NAT type: Full cone (port forwarding will work)

  ? How will you expose headscale to the internet?
  ❯ Port forwarding (I have a public IP or can forward ports)
    VPS relay (I'm behind CGNAT, I'll use a VPS)
    External headscale (I already run headscale elsewhere)
    Skip (I only need L7 discovery, no mesh networking)

  ? Do you have a domain name pointing to this server?
  ❯ Yes → enter domain: openhive.example.com
    No  → set up DuckDNS (free)
    No  → I'll handle DNS myself later

  ? TLS certificate:
  ❯ Let's Encrypt (automatic, recommended)
    I have my own certificate
    My reverse proxy handles TLS

  ? Enable embedded DERP relay? (improves NAT traversal)
  ❯ Yes (recommended)
    No (use Tailscale's public relays)

  Setting up...
  ✓ Generated headscale config → data/headscale/config.yaml
  ✓ Started headscale sidecar
  ✓ Created API key
  ✓ Verified external reachability
  ✓ Updated openhive config

  Done! Swarm hosts can now join your mesh network.
  When a swarm registers and joins a hive, it will receive a
  pre-auth key and instructions for `tailscale up`.
```

### Phase 3: Web-based network dashboard

An admin panel page showing:
- Headscale sidecar status (running/stopped, PID, uptime)
- Connected nodes (name, IPs, online/offline, last seen)
- Hive → headscale user mapping
- Pre-auth key management (create, revoke, expiry)
- Network topology visualization (which swarms can reach which)
- One-click "generate join command" for new swarm hosts

### Phase 4: External headscale support

- Config option to connect to an existing headscale instead of managing the binary
- `headscale.mode: 'sidecar' | 'external'`
- For external mode: just needs `apiUrl` + `apiKey`, no binary management
- Useful for teams that already have headscale infrastructure

### Phase 5: Auto-download headscale binary

- Detect platform (linux/darwin, amd64/arm64)
- Download from `github.com/juanfont/headscale/releases`
- Verify checksum
- Place in `data/headscale/bin/headscale`
- Auto-update on version mismatch

---

## Swarm Operator Experience (End-to-End Flow)

What a swarm operator does to join the mesh:

```
1. Register swarm with OpenHive
   POST /api/v1/map/swarms
   → gets swarm_id + auth_token

2. Join a hive
   POST /api/v1/map/swarms/{id}/hives
   Body: { hive_name: "robotics-lab" }

3. Request network access
   POST /api/v1/map/swarms/{id}/network
   Body: { hive_name: "robotics-lab" }
   → gets: {
       auth_key: "hskey-abc123...",
       instructions: "tailscale up --login-server https://... --authkey hskey-abc123..."
     }

4. On the swarm host machine, install tailscale and run:
   tailscale up --login-server https://openhive.example.com --authkey hskey-abc123...
   → machine gets 100.64.x.y IP
   → can now reach other swarms in the same hive via their 100.64.x.y IPs

5. Query peer list (includes tailscale IPs now)
   GET /api/v1/map/swarms/{id}/peers
   → peers include tailscale_ips and tailscale_dns_name fields
   → swarm can connect to peers via MAP endpoint OR direct WireGuard tunnel
```

---

## Testing Checklist

For validating the setup works end-to-end:

- [ ] Headscale binary found and starts as child process
- [ ] Config.yaml generated with correct paths and options
- [ ] API key bootstrapped on first run, persisted, reused on restart
- [ ] Health check passes within timeout
- [ ] TLS certificate valid and trusted by tailscale client
- [ ] `tailscale up --login-server` succeeds from an external host
- [ ] Node appears in `headscale nodes list`
- [ ] IP assigned from configured prefix
- [ ] MagicDNS resolves within the tailnet
- [ ] Two nodes in the same hive can ping each other via 100.64.x.y
- [ ] Two nodes in different hives **cannot** reach each other (ACL enforcement)
- [ ] Peer list API returns tailscale_ips for connected swarms
- [ ] Pre-auth key expiry is respected
- [ ] Graceful shutdown: SIGTERM → headscale stops → no orphan processes
- [ ] Restart: persisted API key reused, existing nodes reconnect

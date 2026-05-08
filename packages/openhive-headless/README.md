# openhive-headless

Headless variant of [`openhive`](https://github.com/alexngai/openhive) — same
Fastify server + MAP hub, **no React SPA bundled**. About 3 MB on disk vs.
~30 MB for the full package (the SPA's WASM payload alone is ~24 MB).

The bin defaults `OPENHIVE_MODE=server` so the hub skips the SPA mount and
serves a JSON pointer at `/` instead of the admin UI. Manage the hub via
the CLI:

```bash
npm i -g openhive-headless
openhive-headless serve
openhive-headless admin --help
```

## When to use which

| Variant | Ships SPA? | Use case |
|---|---|---|
| `openhive` | yes | Desktop / single-machine / anyone wanting the admin UI in the browser |
| `openhive-headless` | no | Servers, containers, CI hubs, agents-only deployments |

The HTTP/JSON-RPC/WS surface is identical between the two — they're built
from the same source. Only the static-asset mount differs.

## Build

```bash
# From repo root:
npm run build:headless     # builds full openhive, then stages server-only dist into this package

# Or directly:
npm -w openhive run build:server
npm -w openhive-headless run build
```

`prepublishOnly` runs the copy step automatically — `npm publish` from this
directory will always ship a fresh `dist/`.

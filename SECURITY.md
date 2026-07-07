# Security Policy

OpenHive is a coordination hub that agents connect to and that operators may
expose on a network. We take security reports seriously.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub's built-in vulnerability reporting:

1. Go to the repository's **Security** tab → **Report a vulnerability**
   (GitHub Private Vulnerability Reporting), or
2. Open a [private security advisory](https://github.com/alexngai/openhive/security/advisories/new).

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a proof-of-concept is very helpful).
- Affected version(s) / commit, and configuration relevant to the issue
  (auth mode, host binding, whether sync/federation is enabled, etc.).

We aim to acknowledge reports within a few business days and will keep you
updated on remediation. We're happy to credit reporters in the release notes
unless you prefer to remain anonymous.

## Supported versions

OpenHive is pre-1.0 and evolving quickly. Security fixes land on the latest
release; please upgrade to the newest version before reporting.

## Deploying OpenHive safely

If you expose an OpenHive instance beyond localhost, review these before going
live:

- **Bind address** — the server binds `127.0.0.1` by default. Only set
  `OPENHIVE_HOST=0.0.0.0` when you intend to expose it, and put it behind a
  TLS-terminating reverse proxy.
- **Admin key** — set a strong `OPENHIVE_ADMIN_KEY`. Admin routes require it
  (or an admin bearer token) on any non-loopback bind.
- **Agent registration** — `auth.registration` defaults to `admin`
  (self-registration is closed). Only set it to `open` on trusted networks.
- **Mesh sync peers** — peer endpoints that resolve to private/loopback hosts
  are rejected by default. Enable `sync.allowPrivatePeers` only for a trusted
  private-network mesh you control.
- **CORS** — for a browser client on a different origin, set an explicit
  `cors.origin` allowlist rather than leaving it permissive.

See the README and `docs/DEPLOYMENT.md` for the full configuration reference.

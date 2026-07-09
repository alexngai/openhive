# Changelog

All notable changes to OpenHive are documented in this file. The format is based
on [Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security
- Closed an unauthenticated remote-code-execution path in git-remote handling
  (`execFile` instead of a shell, plus URL validation).
- Validated outbound sync/federation peer URLs to prevent SSRF — loopback,
  cloud-metadata, and RFC1918 targets are rejected by default (`sync.allowPrivatePeers`
  to opt into a trusted private mesh).
- Scoped mail conversation reads to fix a cross-tenant IDOR: admins see all,
  discussion scopes (spec/dispatch threads) are hub-visible, everything else is
  participant-only.
- Admin-gated event-subscription mutations.
- `mapHub.trustModel` now defaults to `verified` for a new hub (agents must present
  an operator-issued token); existing hubs are grandfathered to `open` on upgrade.
- Network-bound `local` auth hubs now require a credential on every REST request;
  loopback binds (or `admin.trustLocalMode`) keep the frictionless local-dev auto-auth.
- Gated `POST /agents/register` behind `auth.registration` (default `admin`).
- Rate-limited the password login endpoint.

### Changed
- Default bind address is now `127.0.0.1` (loopback). Set `OPENHIVE_HOST=0.0.0.0`
  (or the config `host`) to expose the hub on the network.
- `openhive init` now prompts for the agent trust model, replacing the previous
  (unenforced) registration-strategy prompt.

### Added
- `LICENSE` (MIT), `SECURITY.md`, `CONTRIBUTING.md`, GitHub issue/PR templates, and a
  guided "Setting up a secure hub" walkthrough in the README.

_Versions prior to this changelog were not tracked here._

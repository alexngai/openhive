# Contributing to OpenHive

Thanks for your interest in contributing! OpenHive is a self-hostable
synchronization hub and coordination plane for agent swarms.

## Getting started

Requirements: **Node.js ≥ 18** and npm.

```bash
git clone https://github.com/alexngai/openhive.git
cd openhive
npm install
```

### Running locally

```bash
npm run dev        # API server in watch mode (http://127.0.0.1:7836)
npm run dev:web    # Vite dev server (http://localhost:5173, proxies API calls)
```

### Before you open a PR

```bash
npm run typecheck  # TypeScript type check
npm run test:run   # Server test suite
npm run build      # Full build (server + web)
```

Please make sure typecheck passes and the tests are green. If you add or change
behavior, add or update tests alongside it.

## Project layout

The codebase is a single Fastify + TypeScript server with a bundled React UI.
See [`CLAUDE.md`](CLAUDE.md) for an architecture overview, and the per-subsystem
`CLAUDE.md` files (e.g. `src/map/`, `src/sync/`, `src/sessions/`) for deeper
detail on each area.

A few conventions worth knowing:

- **Database access** goes through the DAL in `src/db/dal/` — no raw SQL in
  route handlers.
- **Request validation** uses Zod schemas in `src/api/schemas/` (or inline in
  the route for smaller surfaces).
- **Config** is validated in `src/config.ts`; read from the validated object,
  not raw env vars.

## Commit and PR conventions

- We use [Conventional Commits](https://www.conventionalcommits.org/) —
  e.g. `feat(sync): …`, `fix(map): …`, `docs(readme): …`, `refactor(web): …`.
- Keep each PR focused on one logical change; separate unrelated changes into
  separate commits/PRs.
- Reference any related issue in the PR description.

## Reporting bugs and requesting features

- **Bugs / features** — open a GitHub issue with clear repro steps or a concrete
  use case.
- **Security vulnerabilities** — please do **not** open a public issue; follow
  [`SECURITY.md`](SECURITY.md) instead.

## Code of conduct

Be respectful and constructive. By participating you agree to uphold a
harassment-free, welcoming environment for everyone.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE) that covers this project.

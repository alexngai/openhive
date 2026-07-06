/**
 * Schema validation: `SpawnSwarmSchema` — the Zod gate between HTTP
 * callers and `SwarmManager.spawn`.
 *
 * This file pins the validation contract for fields the UI and external
 * operators depend on, focusing on the recently-added `workspace_policy`
 * field and its mode-specific superRefine rules.
 *
 * Tests parse the schema directly. The route's HTTP plumbing (auth,
 * manager lookup) is covered by integration tests; this is the
 * input-validation contract in isolation.
 */

import { describe, it, expect } from 'vitest';
import { SpawnSwarmSchema } from '../../api/routes/swarm-hosting.js';

const baseInput = { kind: 'swarm-runner' as const, name: 'schema-test' };

describe('SpawnSwarmSchema — workspace_policy validation', () => {
  it('normalizes legacy kind=openswarm to kind=swarm-runner', () => {
    const r = SpawnSwarmSchema.safeParse({ kind: 'openswarm', name: 'legacy-kind' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.kind).toBe('swarm-runner');
  });

  // ── Acceptance: well-formed policies ──────────────────────────────────────

  it("accepts mode='open' with no other fields", () => {
    const r = SpawnSwarmSchema.safeParse({
      ...baseInput,
      workspace_policy: { mode: 'open' },
    });
    expect(r.success).toBe(true);
  });

  it("accepts mode='allow_listed' with non-empty allowed_repos", () => {
    const r = SpawnSwarmSchema.safeParse({
      ...baseInput,
      workspace_policy: {
        mode: 'allow_listed',
        allowed_repos: ['https://github.com/foo/bar'],
      },
    });
    expect(r.success).toBe(true);
  });

  it("accepts mode='pinned' with pinned_repo", () => {
    const r = SpawnSwarmSchema.safeParse({
      ...baseInput,
      workspace_policy: {
        mode: 'pinned',
        pinned_repo: 'https://github.com/foo/bar',
      },
    });
    expect(r.success).toBe(true);
  });

  it("accepts omitted workspace_policy (default = open)", () => {
    const r = SpawnSwarmSchema.safeParse(baseInput);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.workspace_policy).toBeUndefined();
  });

  // ── Rejection: mode-specific superRefine ──────────────────────────────────

  it("rejects mode='allow_listed' with no allowed_repos", () => {
    const r = SpawnSwarmSchema.safeParse({
      ...baseInput,
      workspace_policy: { mode: 'allow_listed' },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.includes('allowed_repos'));
      expect(issue?.message).toContain('non-empty');
    }
  });

  it("rejects mode='allow_listed' with empty allowed_repos array", () => {
    const r = SpawnSwarmSchema.safeParse({
      ...baseInput,
      workspace_policy: { mode: 'allow_listed', allowed_repos: [] },
    });
    expect(r.success).toBe(false);
  });

  it("rejects mode='pinned' with no pinned_repo", () => {
    const r = SpawnSwarmSchema.safeParse({
      ...baseInput,
      workspace_policy: { mode: 'pinned' },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.includes('pinned_repo'));
      expect(issue?.message).toContain('required');
    }
  });

  it('rejects unknown mode', () => {
    const r = SpawnSwarmSchema.safeParse({
      ...baseInput,
      workspace_policy: { mode: 'whatever' },
    });
    expect(r.success).toBe(false);
  });

  // ── Length / shape limits ─────────────────────────────────────────────────

  it("caps allowed_repos length at 50", () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `https://x.com/o/r${i}`);
    const r = SpawnSwarmSchema.safeParse({
      ...baseInput,
      workspace_policy: { mode: 'allow_listed', allowed_repos: tooMany },
    });
    expect(r.success).toBe(false);
  });

  it("caps individual URL length at 2000 chars", () => {
    const longUrl = 'https://x.com/' + 'a'.repeat(2001);
    const r = SpawnSwarmSchema.safeParse({
      ...baseInput,
      workspace_policy: { mode: 'pinned', pinned_repo: longUrl },
    });
    expect(r.success).toBe(false);
  });
});

describe('SpawnSwarmSchema — cwd validation', () => {
  // The cwd field is the free-form working directory for TUI / codex
  // spawns. The schema enforces shape + exclusivity; filesystem checks
  // (absolute / exists / is dir) live in the manager so the schema stays
  // pure. These tests pin the schema-layer rules.

  it("accepts cwd for kind='claude-code'", () => {
    const r = SpawnSwarmSchema.safeParse({
      kind: 'claude-code',
      name: 'cwd-test',
      cwd: '/Users/alex/projects/myrepo',
    });
    expect(r.success).toBe(true);
  });

  it("accepts cwd for kind='codex' (any mode)", () => {
    const rRpc = SpawnSwarmSchema.safeParse({
      kind: 'codex',
      name: 'cwd-test',
      cwd: '/Users/alex/projects/myrepo',
    });
    expect(rRpc.success).toBe(true);

    const rTui = SpawnSwarmSchema.safeParse({
      kind: 'codex',
      name: 'cwd-test',
      mode: 'tui',
      cwd: '/Users/alex/projects/myrepo',
    });
    expect(rTui.success).toBe(true);
  });

  it("rejects cwd for kind='swarm-runner' (use bootstrap.cwd instead)", () => {
    const r = SpawnSwarmSchema.safeParse({
      kind: 'swarm-runner',
      name: 'cwd-test',
      cwd: '/Users/alex/projects/myrepo',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.includes('cwd'));
      expect(issue?.message).toContain('bootstrap.cwd');
    }
  });

  it("rejects cwd + repo_id combination (mutually exclusive)", () => {
    const r = SpawnSwarmSchema.safeParse({
      kind: 'claude-code',
      name: 'cwd-test',
      cwd: '/Users/alex/projects/myrepo',
      repo_id: 'repo_abc123',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find(
        (i) => i.path.includes('cwd') && i.message.includes('mutually exclusive'),
      );
      expect(issue?.message).toContain('repo_id');
    }
  });

  it("rejects cwd + workspace combination (mutually exclusive)", () => {
    const r = SpawnSwarmSchema.safeParse({
      kind: 'claude-code',
      name: 'cwd-test',
      cwd: '/Users/alex/projects/myrepo',
      workspace: { repos: [{ url: 'https://github.com/foo/bar' }] },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find(
        (i) => i.path.includes('cwd') && i.message.includes('mutually exclusive'),
      );
      expect(issue?.message).toContain('workspace');
    }
  });

  it("accepts an omitted cwd (default behaviour: data_dir or repo path)", () => {
    const r = SpawnSwarmSchema.safeParse({
      kind: 'claude-code',
      name: 'cwd-test',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.cwd).toBeUndefined();
  });

  it("rejects an empty-string cwd (schema enforces min(1))", () => {
    const r = SpawnSwarmSchema.safeParse({
      kind: 'claude-code',
      name: 'cwd-test',
      cwd: '',
    });
    expect(r.success).toBe(false);
  });
});

describe('SpawnSwarmSchema — runner selection', () => {
  it('accepts a runner for kind=swarm-runner', () => {
    const r = SpawnSwarmSchema.safeParse({ ...baseInput, runner: 'openswarm' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.runner).toBe('openswarm');
  });

  it('accepts an omitted runner (default swarmkit gateway)', () => {
    const r = SpawnSwarmSchema.safeParse(baseInput);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.runner).toBeUndefined();
  });

  it('rejects a runner for kind=claude-code (spawns its own process)', () => {
    const r = SpawnSwarmSchema.safeParse({
      kind: 'claude-code',
      name: 'runner-test',
      runner: 'openswarm',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.includes('runner'));
      expect(issue?.message).toContain('swarm-runner-specific');
    }
  });

  it('rejects a runner for kind=codex', () => {
    const r = SpawnSwarmSchema.safeParse({
      kind: 'codex',
      name: 'runner-test',
      runner: 'openswarm',
    });
    expect(r.success).toBe(false);
  });

  it('rejects an empty-string runner (schema enforces min(1))', () => {
    const r = SpawnSwarmSchema.safeParse({ ...baseInput, runner: '' });
    expect(r.success).toBe(false);
  });
});

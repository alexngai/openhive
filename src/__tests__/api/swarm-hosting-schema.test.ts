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

const baseInput = { kind: 'openswarm' as const, name: 'schema-test' };

describe('SpawnSwarmSchema — workspace_policy validation', () => {
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

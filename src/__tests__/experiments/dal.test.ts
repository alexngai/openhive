/**
 * Experiments DAL roundtrips against a real SQLite DB.
 *
 * Verifies:
 *   - CREATE TABLE happens for all four tables on a fresh DB (via CREATE_TABLES)
 *   - experiments: create/find/list/update/delete + content-hash upsert (D2)
 *   - experiment_runs: create/find/update + JSON column roundtrips
 *   - experiment_candidates: upsert projection convergence + score cards + lists
 *   - experiment_events: append-only, (run_id, seq) idempotency, maxSeq, listing
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as exp from '../../db/dal/experiments.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('experiments-dal');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'experiments-dal.db');

beforeAll(() => {
  cleanTestRoot(TEST_ROOT);
  initDatabase(TEST_DB_PATH);
});

afterAll(() => {
  closeDatabase();
  cleanTestRoot(TEST_ROOT);
});

beforeEach(() => {
  const db = getDatabase();
  db.exec('DELETE FROM experiment_events');
  db.exec('DELETE FROM experiment_candidates');
  db.exec('DELETE FROM experiment_runs');
  db.exec('DELETE FROM experiments');
});

function makeExperiment(
  overrides: Partial<exp.CreateExperimentInput> = {},
): exp.CreateExperimentInput {
  return {
    name: 'optimize mini-swe-agent',
    objective_metric: 'eval.score',
    objective_direction: 'increase',
    config: { evolver: { kind: 'claude-code' }, evaluator: { kind: 'command' } },
    hive_id: 'default-general',
    initiator_type: 'user',
    initiator_id: 'agent_test',
    ...overrides,
  };
}

describe('experiments DAL — fresh schema', () => {
  it('all four experiment tables exist on a fresh DB', () => {
    const db = getDatabase();
    const names = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'experiment%'`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'experiments',
        'experiment_runs',
        'experiment_candidates',
        'experiment_events',
      ]),
    );
  });
});

describe('experiments DAL — experiments CRUD', () => {
  it('createExperiment + findExperimentById roundtrip (JSON config, defaults)', () => {
    const created = exp.createExperiment(makeExperiment());
    expect(created.id).toMatch(/^exp_/);
    expect(created.status).toBe('draft');
    expect(created.objective_min_delta).toBe(0);
    expect(created.content_hash).toBeNull();
    expect(created.incumbent_candidate_id).toBeNull();
    expect(created.config).toEqual({
      evolver: { kind: 'claude-code' },
      evaluator: { kind: 'command' },
    });

    expect(exp.findExperimentById(created.id)).toEqual(created);
  });

  it('upsertExperimentByContentHash: same content_hash returns the same row', () => {
    const a = exp.upsertExperimentByContentHash(
      makeExperiment({ content_hash: 'sha256:abc' }),
    );
    const b = exp.upsertExperimentByContentHash(
      makeExperiment({ content_hash: 'sha256:abc', name: 'different label' }),
    );
    expect(b.id).toBe(a.id); // accumulates under one experiment
    expect(b.name).toBe('optimize mini-swe-agent'); // existing row, not overwritten
    expect(exp.listExperiments().total).toBe(1);
  });

  it('upsertExperimentByContentHash: null content_hash always creates a fresh experiment', () => {
    const a = exp.upsertExperimentByContentHash(makeExperiment());
    const b = exp.upsertExperimentByContentHash(makeExperiment());
    expect(b.id).not.toBe(a.id);
    expect(exp.listExperiments().total).toBe(2);
  });

  it('partial-unique content_hash: two null-hash experiments coexist, duplicate locked hash rejected', () => {
    exp.createExperiment(makeExperiment());
    exp.createExperiment(makeExperiment()); // both null — allowed by partial index
    expect(exp.listExperiments().total).toBe(2);

    exp.createExperiment(makeExperiment({ content_hash: 'sha256:dup' }));
    expect(() => exp.createExperiment(makeExperiment({ content_hash: 'sha256:dup' }))).toThrow();
  });

  it('listExperiments filters by hive_id and status', () => {
    exp.createExperiment(makeExperiment({ hive_id: 'h1', status: 'active' }));
    exp.createExperiment(makeExperiment({ hive_id: 'h1', status: 'archived' }));
    exp.createExperiment(makeExperiment({ hive_id: 'h2', status: 'active' }));

    expect(exp.listExperiments({ hive_id: 'h1' }).total).toBe(2);
    expect(exp.listExperiments({ status: 'active' }).data).toHaveLength(2);
    expect(exp.listExperiments({ hive_id: 'h1', status: 'active' }).data).toHaveLength(1);
  });

  it('updateExperiment sets status, incumbent, and content_hash', () => {
    const created = exp.createExperiment(makeExperiment());
    const updated = exp.updateExperiment(created.id, {
      status: 'active',
      incumbent_candidate_id: 'excand_123',
      content_hash: 'sha256:locked',
    });
    expect(updated!.status).toBe('active');
    expect(updated!.incumbent_candidate_id).toBe('excand_123');
    expect(updated!.content_hash).toBe('sha256:locked');
  });

  it('updateExperiment with empty patch returns existing; unknown id returns null', () => {
    const created = exp.createExperiment(makeExperiment());
    expect(exp.updateExperiment(created.id, {})!.id).toBe(created.id);
    expect(exp.updateExperiment('exp_missing', { status: 'paused' })).toBeNull();
  });

  it('deleteExperiment removes the row (idempotent)', () => {
    const created = exp.createExperiment(makeExperiment());
    expect(exp.deleteExperiment(created.id)).toBe(true);
    expect(exp.findExperimentById(created.id)).toBeNull();
    expect(exp.deleteExperiment(created.id)).toBe(false);
  });
});

describe('experiments DAL — runs', () => {
  function makeRun(experimentId: string): exp.CreateRunInput {
    return {
      experiment_id: experimentId,
      initiator_type: 'schedule',
      initiator_id: 'schedule:sch_1',
      repo_root: '/tmp/target',
      experiment_branch: 'autonomation/experiment/x',
    };
  }

  it('createRun + findRunById roundtrip with queued default', () => {
    const e = exp.createExperiment(makeExperiment());
    const run = exp.createRun(makeRun(e.id));
    expect(run.id).toMatch(/^exrun_/);
    expect(run.status).toBe('queued');
    expect(run.cycles).toBe(0);
    expect(run.initiator_type).toBe('schedule');
    expect(exp.findRunById(run.id)).toEqual(run);
  });

  it('updateRun: JSON columns (env_fingerprint, claim_strength, summary) roundtrip', () => {
    const e = exp.createExperiment(makeExperiment());
    const run = exp.createRun(makeRun(e.id));
    const updated = exp.updateRun(run.id, {
      status: 'running',
      autonomation_run_id: 'arun_xyz',
      hosted_swarm_id: 'swarm_1',
      worker_token_hash: 'sha256:tok',
      content_hash: 'sha256:locked',
      env_fingerprint: { host: 'box-1', hardwareClass: 'm3' },
      claim_strength: { strength: 'capability', label: 'capability lift' },
      cycles: 5,
      total_promoted: 2,
      summary: { stopReason: 'cycle-budget' },
      started_at: '2026-06-24T00:00:00.000Z',
    });
    expect(updated!.status).toBe('running');
    expect(updated!.env_fingerprint).toEqual({ host: 'box-1', hardwareClass: 'm3' });
    expect(updated!.claim_strength).toEqual({
      strength: 'capability',
      label: 'capability lift',
    });
    expect(updated!.summary).toEqual({ stopReason: 'cycle-budget' });
    expect(updated!.cycles).toBe(5);
    expect(updated!.total_promoted).toBe(2);

    expect(exp.findRunByAutonomationRunId('arun_xyz')!.id).toBe(run.id);
  });

  it('listRunsForExperiment scopes to one experiment', () => {
    const e1 = exp.createExperiment(makeExperiment());
    const e2 = exp.createExperiment(makeExperiment());
    exp.createRun(makeRun(e1.id));
    exp.createRun(makeRun(e1.id));
    exp.createRun(makeRun(e2.id));
    expect(exp.listRunsForExperiment(e1.id).total).toBe(2);
    expect(exp.listRunsForExperiment(e2.id).total).toBe(1);
  });
});

describe('experiments DAL — candidates (projection)', () => {
  it('upsertCandidate converges admitted → keep with score cards', () => {
    const e = exp.createExperiment(makeExperiment());
    const run = exp.createRun({ experiment_id: e.id });

    const admitted = exp.upsertCandidate({
      experiment_id: e.id,
      run_id: run.id,
      candidate_ref: 'cand_1',
      status: 'admitted',
      cycle_index: 1,
      base_commit: 'aaa',
      head_commit: 'bbb',
      changed_paths: ['prompt.txt'],
    });
    expect(admitted.id).toMatch(/^excand_/);
    expect(admitted.promoted).toBe(false);

    // Same (run_id, candidate_ref) → updates the same row, fills scores.
    const kept = exp.upsertCandidate({
      experiment_id: e.id,
      run_id: run.id,
      candidate_ref: 'cand_1',
      status: 'keep',
      score_train: 0.8,
      score_held_out: 0.72,
      scores: { 'memory.peak_gb': 4.1 },
      promoted: true,
    });
    expect(kept.id).toBe(admitted.id); // one row, not two
    expect(kept.status).toBe('keep');
    expect(kept.promoted).toBe(true);
    expect(kept.score_train).toBe(0.8);
    expect(kept.score_held_out).toBe(0.72);
    expect(kept.scores).toEqual({ 'memory.peak_gb': 4.1 });
    // omitted-on-update fields preserved from the admitted insert
    expect(kept.changed_paths).toEqual(['prompt.txt']);
    expect(kept.base_commit).toBe('aaa');

    expect(exp.listCandidatesForRun(run.id)).toHaveLength(1);
  });

  it('findCandidate by (run_id, candidate_ref); listCandidatesForExperiment promotedOnly', () => {
    const e = exp.createExperiment(makeExperiment());
    const run = exp.createRun({ experiment_id: e.id });
    exp.upsertCandidate({
      experiment_id: e.id, run_id: run.id, candidate_ref: 'base',
      status: 'baseline', promoted: true,
    });
    exp.upsertCandidate({
      experiment_id: e.id, run_id: run.id, candidate_ref: 'c1',
      status: 'discard', promoted: false,
    });

    expect(exp.findCandidate(run.id, 'base')!.status).toBe('baseline');
    expect(exp.listCandidatesForExperiment(e.id)).toHaveLength(2);
    expect(exp.listCandidatesForExperiment(e.id, { promotedOnly: true })).toHaveLength(1);
  });

  it('update without status preserves the prior terminal status (finalization pass)', () => {
    const e = exp.createExperiment(makeExperiment());
    const run = exp.createRun({ experiment_id: e.id });
    exp.upsertCandidate({
      experiment_id: e.id, run_id: run.id, candidate_ref: 'c1',
      status: 'keep', promoted: true,
    });
    // finalization-style update: scores only, no status — must not clobber 'keep'
    const after = exp.upsertCandidate({
      experiment_id: e.id, run_id: run.id, candidate_ref: 'c1',
      score_train: 0.9, score_held_out: 0.81,
    });
    expect(after.status).toBe('keep');
    expect(after.score_held_out).toBe(0.81);
  });

  it('creating a candidate without a status throws', () => {
    const e = exp.createExperiment(makeExperiment());
    const run = exp.createRun({ experiment_id: e.id });
    expect(() =>
      exp.upsertCandidate({ experiment_id: e.id, run_id: run.id, candidate_ref: 'new' }),
    ).toThrow(/status is required/);
  });
});

describe('experiments DAL — events (append-only)', () => {
  it('appendEvent stores and parses payload; maxSeqForRun tracks the high-water mark', () => {
    const e = exp.createExperiment(makeExperiment());
    const run = exp.createRun({ experiment_id: e.id });

    const ev = exp.appendEvent({
      experiment_id: e.id,
      run_id: run.id,
      seq: 0,
      type: 'experiment_start',
      payload: { runId: 'arun_xyz', message: 'started' },
      message: 'started',
    });
    expect(ev.id).toMatch(/^exev_/);
    expect(ev.payload).toEqual({ runId: 'arun_xyz', message: 'started' });
    expect(exp.maxSeqForRun(run.id)).toBe(0);

    exp.appendEvent({
      experiment_id: e.id, run_id: run.id, seq: 3,
      type: 'promotion_keep', payload: {}, candidate_ref: 'c1', score: 0.72,
    });
    expect(exp.maxSeqForRun(run.id)).toBe(3);
  });

  it('appendEvent is idempotent on (run_id, seq) — a retried POST never double-writes', () => {
    const e = exp.createExperiment(makeExperiment());
    const run = exp.createRun({ experiment_id: e.id });

    const first = exp.appendEvent({
      experiment_id: e.id, run_id: run.id, seq: 7, type: 'cycle_start', payload: { a: 1 },
    });
    const retry = exp.appendEvent({
      experiment_id: e.id, run_id: run.id, seq: 7, type: 'cycle_start', payload: { a: 999 },
    });
    expect(retry.id).toBe(first.id); // same row returned
    expect(retry.payload).toEqual({ a: 1 }); // original wins
    expect(first.inserted).toBe(true);
    expect(retry.inserted).toBe(false);
    expect(exp.listEventsForRun(run.id)).toHaveLength(1);
  });

  it('listEventsForRun orders by seq and respects afterSeq', () => {
    const e = exp.createExperiment(makeExperiment());
    const run = exp.createRun({ experiment_id: e.id });
    for (const seq of [2, 0, 1]) {
      exp.appendEvent({
        experiment_id: e.id, run_id: run.id, seq, type: 'cycle_start', payload: {},
      });
    }
    expect(exp.listEventsForRun(run.id).map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(exp.listEventsForRun(run.id, { afterSeq: 0 }).map((r) => r.seq)).toEqual([1, 2]);
  });
});

/**
 * OpenHiveExperimentTracker — implements autonomation's `ExperimentTracker`
 * (interface imported type-only, so the hub build needs the autonomation types
 * but the compiled hub carries no runtime dependency). POSTs the live event
 * firehose to the hub ingest API.
 *
 * `finish()` deliberately does NOT mark the run terminal — the worker's
 * finalization POST is the single terminal write (it also clears the per-run
 * token). `finish()` only flushes buffered live events.
 */

import type {
  ExperimentTracker,
  ExperimentEvent,
  ExperimentRunMetadata,
  ExperimentRunSummary,
} from 'autonomation/experiment';
import { HubClient } from './hub-client.js';

export interface OpenHiveExperimentTrackerOptions {
  hubUrl: string;
  apiKey: string; // per-run worker token
  experimentId: string;
  runId: string;
  failurePolicy?: 'warn' | 'fail';
  batchSize?: number;
  fetchImpl?: typeof fetch;
  warn?: (message: string) => void;
}

export class OpenHiveExperimentTracker implements ExperimentTracker {
  private readonly client: HubClient;
  private readonly batchSize: number;
  private readonly failurePolicy: 'warn' | 'fail';
  private readonly warn: (message: string) => void;
  private seq = 0;
  private buffer: Array<Record<string, unknown>> = [];
  private flushing: Promise<void> = Promise.resolve();

  constructor(opts: OpenHiveExperimentTrackerOptions) {
    this.client = new HubClient(opts);
    this.batchSize = opts.batchSize ?? 25;
    this.failurePolicy = opts.failurePolicy ?? 'warn';
    this.warn = opts.warn ?? ((m) => console.warn(m));
  }

  async start(meta: ExperimentRunMetadata): Promise<void> {
    await this.guard(() =>
      this.client.patchRun({
        status: 'running',
        autonomation_run_id: meta.runId,
        repo_root: meta.repoRoot || undefined,
        experiment_branch: meta.experimentBranch || undefined,
        experiment_worktree: meta.experimentWorktree || undefined,
        start_point: meta.startPoint,
      }),
    );
  }

  async log(event: ExperimentEvent): Promise<void> {
    this.buffer.push({ ...event, seq: this.seq++ });
    if (this.buffer.length >= this.batchSize) await this.flush();
  }

  async finish(_summary: ExperimentRunSummary): Promise<void> {
    await this.flush();
  }

  /**
   * Flush buffered live events to the hub. Flushes are serialized (one POST in
   * flight, atomic buffer swap) and the un-sent batch is restored to the FRONT
   * of the buffer on failure — so 'warn' retries on the next flush and 'fail'
   * never burns a permanent gap in the hub's (run_id, seq) sequence.
   */
  async flush(): Promise<void> {
    const next = this.flushing.catch(() => {}).then(() => this.flushOnce());
    this.flushing = next.catch(() => {}); // keep the chain alive across failures
    return next;
  }

  private async flushOnce(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.client.postEvents(batch);
    } catch (err) {
      this.buffer = batch.concat(this.buffer); // restore for the next flush
      if (this.failurePolicy === 'fail') throw err;
      this.warn(`OpenHive tracker: ${(err as Error).message}`);
    }
  }

  private async guard(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (this.failurePolicy === 'fail') throw err;
      this.warn(`OpenHive tracker: ${(err as Error).message}`);
    }
  }
}

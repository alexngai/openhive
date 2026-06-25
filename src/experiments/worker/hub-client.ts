/**
 * HTTP client for the experiment worker → hub ingest API.
 *
 * Used by `OpenHiveExperimentTracker` (live events) and the finalization step.
 * `fetchImpl` is injectable so tests can route to an in-process Fastify app
 * without a real socket. Auth is the per-run worker token (Bearer).
 */

export interface HubClientOptions {
  hubUrl: string;
  apiKey: string; // the per-run worker token
  experimentId: string;
  runId: string;
  fetchImpl?: typeof fetch;
}

export interface FinalizeCandidatePayload {
  candidate_ref: string;
  parent_candidate_ref?: string;
  status?: string;
  cycle_index?: number;
  base_commit?: string;
  head_commit?: string;
  changed_paths?: string[];
  score_train?: number;
  score_held_out?: number;
  scores?: Record<string, number>;
  promoted?: boolean;
  rationale?: string;
  failure_reason?: string;
}

export interface FinalizePayload {
  status?: 'complete' | 'failed';
  content_hash?: string | null;
  claim_strength?: unknown;
  env_fingerprint?: unknown;
  stop_reason?: string | null;
  stop_message?: string | null;
  summary?: unknown;
  cycles?: number;
  total_proposed?: number;
  total_admitted?: number;
  total_promoted?: number;
  candidate_failures?: number;
  candidates?: FinalizeCandidatePayload[];
}

export class HubClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HubClientOptions) {
    this.base = `${opts.hubUrl.replace(/\/$/, '')}/api/v1/experiments/${encodeURIComponent(
      opts.experimentId,
    )}/runs/${encodeURIComponent(opts.runId)}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async send(method: string, path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`hub ${method} ${this.base}${path} → ${res.status} ${text}`);
    }
    return res.json().catch(() => ({}));
  }

  patchRun(body: Record<string, unknown>): Promise<unknown> {
    return this.send('PATCH', '', body);
  }

  postEvents(events: unknown[]): Promise<unknown> {
    return this.send('POST', '/events', { events });
  }

  finalize(payload: FinalizePayload): Promise<unknown> {
    return this.send('POST', '/finalize', payload);
  }
}

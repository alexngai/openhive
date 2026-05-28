/**
 * `openhive hook claude <event>` — forward a Claude Code lifecycle hook
 * callback to the openhive hub. This is invoked by claude itself via the
 * `--settings` payload openhive injects when it spawns a `claude-code`
 * TUI (see `src/swarm/tui-strategies.ts:makeClaudeCodeStrategy.buildHookSettings`).
 *
 * Contract:
 *   - reads OPENHIVE_HUB_URL / OPENHIVE_HOSTED_SWARM_ID / OPENHIVE_HOOK_TOKEN
 *     from env (set by the spawn pipeline alongside the `--settings` args)
 *   - reads claude's stdin JSON payload (session_id, transcript_path, cwd…)
 *   - POSTs to /api/v1/map/hosted/:id/hook/:event with `Bearer <token>`
 *   - silent on success — claude inspects the exit code, not stdout
 *
 * Failure modes are deliberately non-fatal (resolve to a status string
 * rather than throw). The Commander action collapses every outcome to
 * exit 0 so a transient hub blip doesn't surface as a hook failure in
 * the TUI — the missed dot is a much smaller cost than a red banner.
 */

export type HookResult = 'skipped' | 'ok' | `http_${number}` | 'error';

export interface ForwardClaudeHookOpts {
  env: NodeJS.ProcessEnv;
  stdin: AsyncIterable<Buffer | string>;
  fetchFn?: typeof fetch;
}

/** Cap on bytes read from stdin. A misbehaving caller can't pin us forever. */
const MAX_STDIN_BYTES = 64 * 1024;
/** Total request timeout. Keep short — Claude waits for hooks synchronously. */
const REQUEST_TIMEOUT_MS = 3000;

export async function forwardClaudeHook(
  event: string,
  opts: ForwardClaudeHookOpts,
): Promise<HookResult> {
  const hubUrl = opts.env.OPENHIVE_HUB_URL;
  const hostedId = opts.env.OPENHIVE_HOSTED_SWARM_ID;
  const token = opts.env.OPENHIVE_HOOK_TOKEN;
  // No env → not running under openhive (user has the hooks globally
  // installed but launched claude outside an openhive-spawned terminal).
  // Skip silently so global installs don't break standalone runs.
  if (!hubUrl || !hostedId || !token) return 'skipped';

  // Claude pipes a JSON payload on stdin. Read defensively — some hook
  // variants send nothing and we don't own the schema. Forward whatever
  // we got verbatim so the route can pick out session_id /
  // transcript_path / cwd without us knowing the full shape.
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of opts.stdin) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    chunks.push(buf);
    total += buf.length;
    if (total > MAX_STDIN_BYTES) break;
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  let payload: unknown = {};
  if (raw) {
    try { payload = JSON.parse(raw); } catch { payload = { raw }; }
  }

  const url = `${hubUrl.replace(/\/$/, '')}/api/v1/map/hosted/${encodeURIComponent(hostedId)}/hook/${encodeURIComponent(event)}`;
  const doFetch = opts.fetchFn ?? fetch;
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) return 'ok';
    console.error(`[openhive hook] ${event} → ${res.status}`);
    return `http_${res.status}` as HookResult;
  } catch (err) {
    console.error(`[openhive hook] ${event} failed: ${(err as Error).message}`);
    return 'error';
  }
}

/**
 * Process-level safety net for orphaned-promise rejections from
 * `@multi-agent-protocol/sdk`'s ACP stream. Extracted from cli.ts so the
 * matcher can be unit-tested without importing the CLI entry (which
 * `program.parse()`s on load).
 */

/**
 * Matches the two orphaned-promise rejection patterns that leak out of the MAP
 * SDK's ACP stream and would otherwise crash the hub under Node's default
 * `--unhandled-rejections=throw`:
 *
 *   • 'ACP stream closed' — a close-race: `close()` runs while an RPC is
 *     in-flight, so the pending promise is rejected but never awaited (the same
 *     method throws synchronously right after). The SDK has been patched
 *     (references/multi-agent-protocol/ts-sdk/src/acp/stream.ts #sendRequest),
 *     but node_modules may still carry an unpatched copy.
 *   • 'ACP request timed out after Nms: …' — the request's timeout timer
 *     rejects a stored promise nobody awaits once the calling route has already
 *     surfaced the error to its caller (e.g. `/sessions/acp-connect` returning
 *     "ACP request timed out … initialize" when a hosted swarm never answers).
 *
 * Both are already reported to the request's caller; only the dangling internal
 * rejection remains, and a remote agent being slow/broken is an operational
 * condition — never a hub bug. Everything else must keep crashing so genuine
 * bugs surface, hence the stack-trace smell test pinning the origin to the SDK's
 * acp stream module.
 */
export function isAcpStreamRace(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false;
  const msg = reason.message;
  const isKnownRace =
    msg === 'ACP stream closed' ||
    /^ACP request timed out after \d+ms/.test(msg);
  if (!isKnownRace) return false;
  return typeof reason.stack === 'string'
    && /multi-agent-protocol\/sdk.*acp\/stream|acp\/stream\.ts/.test(reason.stack);
}

/**
 * Install the `unhandledRejection` guard. Suppresses (logs) the ACP-stream
 * races above and keeps the hub alive; rethrows everything else to preserve
 * Node's fail-fast default for genuine bugs.
 */
export function installAcpRaceSafetyNet(): void {
  process.on('unhandledRejection', (reason) => {
    if (isAcpStreamRace(reason)) {
      console.warn(
        '[acp] suppressed SDK ACP-stream rejection (kept hub alive):',
        (reason as Error).message,
      );
      return;
    }
    // Preserve Node's default crash behavior for anything else.
    throw reason;
  });
}

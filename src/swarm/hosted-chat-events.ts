/**
 * Hosted-chat event normalization.
 *
 * The frontend chat adapter consumes a stable, provider-agnostic event
 * shape so the same React hook + component renders streaming output
 * regardless of which underlying agent runtime is driving it. Each
 * programmatic-mode provider (codex `mode: 'rpc'` today, future
 * alternatives) implements a translator from its native protocol into
 * this shape. The manager bridge runs the translator and broadcasts the
 * normalized event on the per-swarm WS channel `hosted-chat:<hostedId>`.
 *
 * Adding a new provider: implement a translator returning a
 * `HostedChatEvent` (or null to suppress) per native event. Wire it into
 * the manager's broadcast hook the same way `translateCodexNotification`
 * is wired below.
 */

/**
 * Normalized permission flavor surfaced to the chat layer. `exec` covers
 * shell/command execution; `patch` covers file changes; `other` covers
 * anything else (network policy escalations, MCP elicitations, etc.) that
 * still needs a yes/no but doesn't fit the first two buckets cleanly.
 */
export type HostedChatPermissionFlavor = 'exec' | 'patch' | 'other';

/** Normalized permission request surfaced to the chat layer. */
export interface HostedChatPermissionRequest {
  /** Provider-issued request id (preserved verbatim so the reply routes back). */
  requestId: string;
  flavor: HostedChatPermissionFlavor;
  /** Short user-facing description (e.g. command text or summary of patch). */
  summary: string;
  /** Optional longer reason supplied by the provider. */
  reason?: string;
  /** Original provider method, for debugging / advanced surfaces. */
  providerMethod: string;
  /** Original params verbatim, for advanced surfaces that want details. */
  providerParams?: unknown;
}

/** Normalized event the frontend hosted-chat adapter consumes. */
export type HostedChatEvent =
  | { kind: 'message.start'; itemId: string; role: 'assistant' | 'user' | 'system' }
  | { kind: 'message.delta'; itemId: string; delta: string }
  | { kind: 'message.complete'; itemId: string; finalText?: string }
  | { kind: 'turn.started'; turnId: string }
  | { kind: 'turn.completed'; turnId: string }
  | { kind: 'error'; message: string; code?: string | number }
  /**
   * Provider is asking the user to approve or deny a tool/command/patch.
   * Renderer shows an Allow/Deny dialog. Reply via the host's
   * `replyPermission(hostedSwarmId, requestId, decision)` path.
   */
  | { kind: 'permission.request'; request: HostedChatPermissionRequest }
  /**
   * Provider's pending permission was resolved (either by this client or a
   * sibling tab on the same hosted swarm). Renderer dismisses the dialog.
   */
  | { kind: 'permission.resolved'; requestId: string; decision: 'approved' | 'denied' }
  /**
   * Escape hatch for events that don't (yet) have a normalized
   * counterpart. The frontend can render these as inert telemetry, ignore
   * them, or surface them in a debug panel. Provider name + raw payload
   * are preserved verbatim.
   */
  | { kind: 'raw'; provider: string; method: string; params?: unknown };

// ============================================================================
// Codex translator (codex `mode: 'rpc'`)
// ============================================================================

interface CodexItemRef {
  id: string;
  type?: string;
  text?: string;
}

/**
 * Translate a codex app-server JSON-RPC notification into a normalized
 * `HostedChatEvent`. Returns null when the codex notification doesn't map
 * to anything UI-renderable (telemetry events that the chat adapter
 * shouldn't surface — rate limits, MCP startup, raw response items, etc.).
 *
 * The frontend treats `kind: 'raw'` as opaque, so when in doubt, prefer
 * returning a raw passthrough over null — that way debug surfaces can
 * still see the event without changing the frontend contract.
 */
export function translateCodexNotification(
  method: string,
  params: unknown,
): HostedChatEvent | null {
  switch (method) {
    case 'turn/started': {
      // codex's TurnStartedNotification carries the turn id; nest it in
      // either `turn.id` or `turnId` depending on payload shape. Fall
      // back to '' so the translator never drops the lifecycle phase
      // just because the id field shifted.
      const p = params as { turn?: { id?: string }; turnId?: string } | undefined;
      const turnId = p?.turn?.id ?? p?.turnId ?? '';
      return { kind: 'turn.started', turnId };
    }
    case 'turn/completed': {
      const p = params as { turn?: { id?: string }; turnId?: string } | undefined;
      const turnId = p?.turn?.id ?? p?.turnId ?? '';
      return { kind: 'turn.completed', turnId };
    }
    case 'item/started': {
      const p = params as { item?: CodexItemRef } | undefined;
      const item = p?.item;
      if (!item?.id) return null;
      // Map codex's per-item `type` to the normalized role. Roles outside
      // assistant/user/system pass through as raw — keeps the union
      // closed without losing information.
      let role: 'assistant' | 'user' | 'system' | null = null;
      if (item.type === 'agentMessage') role = 'assistant';
      else if (item.type === 'userMessage') role = 'user';
      else if (item.type === 'systemMessage') role = 'system';
      if (role) return { kind: 'message.start', itemId: item.id, role };
      // Tool call / file change / reasoning items → raw passthrough.
      return { kind: 'raw', provider: 'codex', method, params };
    }
    case 'item/agentMessage/delta': {
      const p = params as { itemId?: string; delta?: string } | undefined;
      if (!p?.itemId || typeof p.delta !== 'string') return null;
      return { kind: 'message.delta', itemId: p.itemId, delta: p.delta };
    }
    case 'item/completed': {
      const p = params as { item?: CodexItemRef } | undefined;
      const item = p?.item;
      if (!item?.id) return null;
      if (item.type === 'agentMessage') {
        return { kind: 'message.complete', itemId: item.id, finalText: item.text };
      }
      return { kind: 'raw', provider: 'codex', method, params };
    }
    case 'error': {
      const p = params as { message?: string; code?: string | number } | undefined;
      return { kind: 'error', message: p?.message ?? 'codex error', code: p?.code };
    }
    default:
      // Telemetry / lifecycle notifications we don't surface in chat:
      // mcpServer/startupStatus/updated, account/rateLimits/updated,
      // thread/started, thread/status/changed, thread/tokenUsage/updated,
      // remoteControl/status/changed, etc. Drop to raw so debug panels can
      // still see them without bloating the chat list.
      return { kind: 'raw', provider: 'codex', method, params };
  }
}

// ============================================================================
// Codex request translator (server → client JSON-RPC requests requiring reply)
// ============================================================================

/**
 * Methods in codex's `ServerRequest` union that we don't auto-translate
 * into a user-facing permission prompt. The bridge can decide to
 * auto-reply with an error or surface them as raw events for advanced
 * handling. Listed here for the audit trail rather than fingerprinted at
 * use sites.
 */
const NON_APPROVAL_CODEX_REQUESTS = new Set([
  'item/tool/call',
  'account/chatgptAuthTokens/refresh',
  'attestation/generate',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
]);

/**
 * Translate a codex app-server JSON-RPC **request** (server-initiated,
 * requires reply) into a normalized `HostedChatEvent`. Returns null when
 * the method isn't a user-approval prompt — the caller decides whether to
 * auto-reply with an error, surface it as `raw`, or ignore.
 *
 * Schema source: openai/codex `codex-rs/app-server-protocol/schema/typescript/ServerRequest.ts`.
 */
export function translateCodexRequest(
  method: string,
  params: unknown,
  requestId: string,
): HostedChatEvent | null {
  switch (method) {
    case 'execCommandApproval':
    case 'item/commandExecution/requestApproval': {
      const p = (params ?? {}) as {
        command?: string | string[];
        cwd?: string;
        reason?: string | null;
      };
      const cmd = Array.isArray(p.command) ? p.command.join(' ') : (p.command ?? '');
      const summary = cmd
        ? (p.cwd ? `${cmd}  (cwd: ${p.cwd})` : cmd)
        : 'Run a shell command';
      return {
        kind: 'permission.request',
        request: {
          requestId,
          flavor: 'exec',
          summary,
          reason: p.reason ?? undefined,
          providerMethod: method,
          providerParams: params,
        },
      };
    }
    case 'applyPatchApproval':
    case 'item/fileChange/requestApproval': {
      const p = (params ?? {}) as {
        fileChanges?: Record<string, unknown>;
        reason?: string | null;
      };
      const paths = p.fileChanges ? Object.keys(p.fileChanges) : [];
      const summary = paths.length === 0
        ? 'Apply file changes'
        : paths.length === 1
          ? `Apply patch to ${paths[0]}`
          : `Apply patch to ${paths.length} files`;
      return {
        kind: 'permission.request',
        request: {
          requestId,
          flavor: 'patch',
          summary,
          reason: p.reason ?? undefined,
          providerMethod: method,
          providerParams: params,
        },
      };
    }
    case 'item/permissions/requestApproval': {
      const p = (params ?? {}) as { reason?: string | null };
      return {
        kind: 'permission.request',
        request: {
          requestId,
          flavor: 'other',
          summary: 'Permission escalation',
          reason: p.reason ?? undefined,
          providerMethod: method,
          providerParams: params,
        },
      };
    }
    default:
      if (NON_APPROVAL_CODEX_REQUESTS.has(method)) {
        // Known non-approval methods — caller surfaces as raw and
        // auto-errors via the JSON-RPC reply path.
        return { kind: 'raw', provider: 'codex', method, params };
      }
      // Truly unknown — preserve in raw for debugging.
      return { kind: 'raw', provider: 'codex', method, params };
  }
}

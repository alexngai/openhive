/**
 * Feature flags for chat-fab context-injection UI.
 *
 * See §7.0/§7.1 of docs/CHAT_CONTEXT_INJECTION_DESIGN.md. Chip-based staging +
 * hover preview are the default path everywhere. The environment variable
 * `VITE_CHAT_CONTEXT_CHIPS=false` is an explicit escape hatch to disable the
 * chip UI (rollback lever); any other value — including unset — leaves chips
 * enabled.
 */

const FLAG_KEY = 'VITE_CHAT_CONTEXT_CHIPS';

function readEnvFlag(): string | undefined {
  try {
    const env = (import.meta as { env?: Record<string, unknown> }).env;
    const viaImport = env?.[FLAG_KEY];
    if (typeof viaImport === 'string') return viaImport;
  } catch {
    /* no-op */
  }
  try {
    const env = (globalThis as { process?: { env?: Record<string, unknown> } }).process?.env;
    const viaProcess = env?.[FLAG_KEY];
    if (typeof viaProcess === 'string') return viaProcess;
  } catch {
    /* no-op */
  }
  return undefined;
}

export function isChatContextChipsEnabled(): boolean {
  return readEnvFlag() !== 'false';
}

/** Module-evaluation-time snapshot. Lets Vite statically resolve the branch
 * at build time and tree-shake the disabled path. Prefer this constant in
 * product code; the function is retained for tests that use `vi.stubEnv`. */
export const CHAT_CONTEXT_CHIPS = isChatContextChipsEnabled();

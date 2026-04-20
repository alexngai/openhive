import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Wire main-process deep-link + focus-route IPC events into react-router.
 *
 * URL contract: `openhive://<path>` maps directly to `/<path>` in the
 * SPA. Examples:
 *   openhive://threads/abc123        → /threads/abc123
 *   openhive://swarms/xyz            → /swarms/xyz
 *   openhive://settings              → /settings
 *
 * No-op outside the Electron shell (`window.openhive` is undefined in
 * plain browsers + the Vite dev server).
 */
export function useElectronDeepLinks(): void {
  const navigate = useNavigate();

  useEffect(() => {
    const bridge = window.openhive;
    if (!bridge) return;

    const handle = (input: string): void => {
      const route = toRoute(input);
      if (route) navigate(route);
    };

    const disposeDeep = bridge.onDeepLink(handle);
    const disposeFocus = bridge.onFocusRoute(handle);
    // Tell main we're listening — flushes any cold-start deep link that's
    // been waiting since before the React app mounted.
    bridge.ready();
    return () => {
      disposeDeep();
      disposeFocus();
    };
  }, [navigate]);
}

/**
 * Normalize an `openhive://…` URL or a bare route string into a leading-
 * slash SPA path. Returns null if the input is unparseable.
 */
function toRoute(input: string): string | null {
  if (!input) return null;
  if (input.startsWith('openhive://')) {
    // URL parsing of custom schemes is finicky — strip manually so we don't
    // have to care whether the host portion is empty (`openhive://settings`)
    // vs populated (`openhive://swarms/abc`).
    const rest = input.slice('openhive://'.length).replace(/^\/+/, '');
    if (!rest) return '/';
    return `/${rest}`;
  }
  if (input.startsWith('/')) return input;
  return null;
}

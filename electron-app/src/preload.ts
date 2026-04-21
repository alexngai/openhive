/**
 * Renderer preload script.
 *
 * Bridges a tightly-scoped main-process surface into the renderer via
 * contextBridge — no direct ipcRenderer / Node access is exposed. The
 * SPA otherwise talks to Fastify over plain HTTP/WS and needs nothing
 * else from us.
 *
 * Surface (mirrors the IPC handlers in src/main.ts):
 *   window.openhive.notify(payload)        → "openhive:notify"
 *   window.openhive.setBadge(count)        → "openhive:set-badge"
 *   window.openhive.onDeepLink(cb)         ← "openhive:deep-link"      (returns dispose)
 *   window.openhive.onFocusRoute(cb)       ← "openhive:focus-route"    (returns dispose)
 *   window.openhive.platform               = process.platform string
 *
 * Renderer integration lives in src/web/hooks/useDeepLinks.ts (deep links
 * → react-router) and is wired from the App root. Notification + badge
 * triggers are intentionally left to the SPA — main only ships the OS
 * call, not the policy.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

interface NotifyPayload {
  title: string;
  body: string;
  /** Optional `openhive://…` URL (or any string the renderer wants) to
   *  hand back via `openhive:focus-route` when the user clicks. */
  route?: string;
}

type StringListener = (value: string) => void;
type Dispose = () => void;

function subscribeString(channel: string, listener: StringListener): Dispose {
  const handler = (_event: IpcRendererEvent, value: unknown): void => {
    listener(typeof value === 'string' ? value : String(value));
  };
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.off(channel, handler); };
}

contextBridge.exposeInMainWorld('openhive', {
  platform: process.platform,

  /** Called by useElectronDeepLinks once it's subscribed. Tells main it's
   *  safe to flush any pending cold-start deep link to this window. */
  ready(): void {
    ipcRenderer.send('openhive:renderer-ready');
  },

  notify(payload: NotifyPayload): void {
    if (!payload || typeof payload.title !== 'string' || typeof payload.body !== 'string') return;
    ipcRenderer.send('openhive:notify', payload);
  },

  setBadge(count: number): void {
    if (typeof count !== 'number' || !Number.isFinite(count)) return;
    ipcRenderer.send('openhive:set-badge', count);
  },

  onDeepLink(listener: StringListener): Dispose {
    return subscribeString('openhive:deep-link', listener);
  },

  onFocusRoute(listener: StringListener): Dispose {
    return subscribeString('openhive:focus-route', listener);
  },
});

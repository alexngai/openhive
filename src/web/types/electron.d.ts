/**
 * Ambient type declarations for the Electron preload bridge.
 *
 * `window.openhive` is exposed only when the SPA is loaded inside the
 * OpenHive Electron shell (electron-app/src/preload.ts). Plain browser
 * loads (Chrome, Vite dev server) leave it `undefined` — every consumer
 * must guard accordingly.
 */
export {};

declare global {
  interface OpenHiveBridge {
    readonly platform: NodeJS.Platform;
    /** Signal main that this renderer has subscribed to deep-link / focus-
     *  route IPC. Main holds cold-start deep links until this fires. */
    ready(): void;
    notify(payload: { title: string; body: string; route?: string }): void;
    setBadge(count: number): void;
    onDeepLink(listener: (url: string) => void): () => void;
    onFocusRoute(listener: (route: string) => void): () => void;
  }
  interface Window {
    openhive?: OpenHiveBridge;
  }
}

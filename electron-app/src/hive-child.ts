/**
 * Hive child-process entry point.
 *
 * Runs one OpenHive instance inside a node:child_process.fork'd child
 * (forked from the Electron supervisor with ELECTRON_RUN_AS_NODE=1). Each
 * hive-child has its own module scope, so OpenHive's singleton state
 * (db, jwks, storage) does not collide across hives.
 *
 * Uses standard Node IPC (process.on('message') / process.send()) rather
 * than Electron's utilityProcess MessageChannel — utilityProcess has a
 * restricted Node environment that prevents loading several native modules
 * OpenHive requires (notably better-sqlite3).
 */

type HiveServer = {
  start(): Promise<string>;
  stop(): Promise<void>;
};

type StartMessage = {
  type: 'start';
  config: Record<string, unknown> & { dataDir?: string };
};

type StopMessage = { type: 'stop' };
type InMessage = StartMessage | StopMessage;

type OutMessage =
  | { type: 'ready'; url: string }
  | { type: 'error'; message: string; fatal: boolean };

let hive: HiveServer | null = null;
let stopping = false;

function post(msg: OutMessage): void {
  if (process.send) process.send(msg);
}

function fatal(message: string): void {
  // Write to stderr (piped to the per-hive log file by the supervisor) so
  // crash reasons are visible even when IPC itself is compromised.
  try { process.stderr.write(`[hive-child] fatal: ${message}\n`); } catch { /* ignore */ }
  post({ type: 'error', message, fatal: true });
  process.exit(1);
}

process.on('message', (data: InMessage) => {
  void (async () => {
    try {
      if (data.type === 'start') {
        if (typeof data.config.dataDir === 'string') {
          process.env.OPENHIVE_HOME = data.config.dataDir;
        }
        // Dynamic import so createHive is loaded lazily — only after we
        // know the hive's config. `openhive` is a real dependency of this
        // package (via `file:..`, symlinked at dev time; bundled into
        // node_modules on package), so normal module resolution works at
        // runtime. Held in a variable so TypeScript treats the specifier as
        // dynamic and doesn't try to resolve types from openhive's dist
        // (which may not have a .d.ts available in all build states).
        const specifier = 'openhive';
        const mod = (await import(specifier)) as {
          createHive: (c: unknown) => Promise<HiveServer>;
        };
        hive = await mod.createHive(data.config);
        const url = await hive.start();
        post({ type: 'ready', url });
      } else if (data.type === 'stop') {
        if (stopping) return;
        stopping = true;
        try {
          if (hive) await hive.stop();
        } finally {
          process.exit(0);
        }
      }
    } catch (err) {
      fatal((err as Error).message);
    }
  })();
});

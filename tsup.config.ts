import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    map: 'src/map/client-entry.ts',
  },
  format: ['esm'],
  shims: true,
  // Build-only tsconfig that pins `types: ["node"]` so the .d.ts build
  // doesn't auto-scan a possibly-inconsistent node_modules/@types/ — see
  // tsconfig.build.json for the why.
  tsconfig: 'tsconfig.build.json',
  dts: true,
  splitting: false,
  // Server sourcemaps add ~6 MB to the bundle but are only useful when
  // debugging tsup-bundled server code. Opt in with TSUP_SOURCEMAP=true.
  sourcemap: process.env.TSUP_SOURCEMAP === 'true',
  clean: true,
  target: 'node18',
  outDir: 'dist',
  // `autonomation` is an OPTIONAL peer dep loaded only by the experiment worker
  // via a dynamic import — never bundle it, so the hub builds/runs without it.
  external: ['better-sqlite3', '@google-cloud/storage', 'autonomation'],
});

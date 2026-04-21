import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    map: 'src/map/client-entry.ts',
  },
  format: ['esm'],
  shims: true,
  dts: true,
  splitting: false,
  // Server sourcemaps add ~6 MB to the bundle but are only useful when
  // debugging tsup-bundled server code. Opt in with TSUP_SOURCEMAP=true.
  sourcemap: process.env.TSUP_SOURCEMAP === 'true',
  clean: true,
  target: 'node18',
  outDir: 'dist',
  external: ['better-sqlite3', '@google-cloud/storage'],
});

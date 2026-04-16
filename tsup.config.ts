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
  sourcemap: true,
  clean: true,
  target: 'node18',
  outDir: 'dist',
  external: ['better-sqlite3', '@google-cloud/storage'],
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import path from 'path';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
  ],
  root: __dirname,
  base: '/',
  publicDir: 'public',
  // Polyfill Buffer for isomorphic-git (Node.js API needed in browser)
  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    exclude: ['kuzu-wasm'],
    include: ['buffer'],
  },
  build: {
    outDir: path.resolve(__dirname, '../../dist/web'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        sw: path.resolve(__dirname, 'sw.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          // Service worker should be at root, not in assets folder
          if (chunkInfo.name === 'sw') {
            return 'sw.js';
          }
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss(path.resolve(__dirname, '../../tailwind.config.js')),
        autoprefixer(),
      ],
    },
  },
  resolve: {
    alias: {
      '@': __dirname,
      // Fix for mermaid d3-color prototype crash (known issue with mermaid 10.9.0+ and Vite)
      'mermaid': path.resolve(__dirname, '../../node_modules/mermaid/dist/mermaid.esm.min.mjs'),
    },
  },
  server: {
    port: 5173,
    // Required for KuzuDB WASM (SharedArrayBuffer needs Cross-Origin Isolation)
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    // Allow serving files from SwarmCraft source + node_modules
    fs: {
      allow: ['../..'],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
      '/skill.md': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/.well-known': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  // Worker configuration for SwarmCraft's ingestion workers
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  base: '/',
  publicDir: 'public',
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
    },
  },
  server: {
    port: 5173,
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
});

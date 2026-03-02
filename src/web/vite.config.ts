import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  base: "/",
  publicDir: "public",
  build: {
    outDir: path.resolve(__dirname, "../../dist/web"),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        sw: path.resolve(__dirname, "sw.ts"),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          // Service worker should be at root, not in assets folder
          if (chunkInfo.name === "sw") {
            return "sw.js";
          }
          return "assets/[name]-[hash].js";
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": __dirname,
      // Fix for mermaid d3-color prototype crash (known issue with mermaid 10.9.0+ and Vite)
      mermaid: path.resolve(
        __dirname,
        "../../node_modules/mermaid/dist/mermaid.esm.min.mjs",
      ),
    },
  },
  server: {
    port: 5173,
    // Allow serving files from SwarmCraft source + node_modules
    fs: {
      allow: ["../.."],
    },
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.OPENHIVE_DEV_PORT || 3000}`,
        changeOrigin: true,
      },
      "/ws": {
        target: `ws://127.0.0.1:${process.env.OPENHIVE_DEV_PORT || 3000}`,
        ws: true,
      },
      "/skill.md": {
        target: `http://127.0.0.1:${process.env.OPENHIVE_DEV_PORT || 3000}`,
        changeOrigin: true,
      },
      "/.well-known": {
        target: `http://127.0.0.1:${process.env.OPENHIVE_DEV_PORT || 3000}`,
        changeOrigin: true,
      },
    },
  },
});

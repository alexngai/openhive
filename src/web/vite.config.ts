import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";

// Read backend port from .dev-port file (written by backend on startup)
// Falls back to OPENHIVE_DEV_PORT env var, then 3000
function getBackendPort(): number {
  try {
    const portFile = path.resolve(__dirname, "../../.dev-port");
    const port = parseInt(fs.readFileSync(portFile, "utf-8").trim(), 10);
    if (port > 0) return port;
  } catch {
    // File doesn't exist yet — use fallback
  }
  return parseInt(process.env.OPENHIVE_DEV_PORT || "3000", 10);
}

const backendPort = getBackendPort();

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
      "/api/": {
        target: `http://127.0.0.1:${backendPort}`,
        changeOrigin: true,
      },
      "/ws": {
        target: `ws://127.0.0.1:${backendPort}`,
        ws: true,
      },
      "/skill.md": {
        target: `http://127.0.0.1:${backendPort}`,
        changeOrigin: true,
      },
      "/.well-known": {
        target: `http://127.0.0.1:${backendPort}`,
        changeOrigin: true,
      },
    },
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";

// Read backend port from .dev-port file (written by backend on startup)
// Falls back to OPENHIVE_DEV_PORT env var, then 7836
function getBackendPort(): number {
  try {
    const portFile = path.resolve(__dirname, "../../.dev-port");
    const port = parseInt(fs.readFileSync(portFile, "utf-8").trim(), 10);
    if (port > 0) return port;
  } catch {
    // File doesn't exist yet — use fallback
  }
  return parseInt(process.env.OPENHIVE_DEV_PORT || "7836", 10);
}

const backendPort = getBackendPort();
const devPort = parseInt(process.env.VITE_DEV_PORT || "5173", 10);

/**
 * Resolve aliases. For swarmcraft's UI entry/CSS we prefer the local
 * `references/swarmcraft` source tree when it exists (live-edit during
 * development) and fall through to node_modules resolution via the
 * package.json `exports` map when it doesn't — which is what happens
 * on CI runners and in any clone without references/ populated.
 */
function buildResolveAlias(): Record<string, string> {
  const alias: Record<string, string> = {
    "@": __dirname,
    // Fix for mermaid d3-color prototype crash (known issue with mermaid 10.9.0+ and Vite)
    mermaid: path.resolve(
      __dirname,
      "../../node_modules/mermaid/dist/mermaid.esm.min.mjs",
    ),
  };
  const swarmcraftSrc = path.resolve(__dirname, "../../references/swarmcraft/src/ui");
  if (fs.existsSync(path.join(swarmcraftSrc, "embed.ts"))) {
    alias["swarmcraft/ui/embed"] = path.join(swarmcraftSrc, "embed.ts");
    alias["swarmcraft/ui/embed.css"] = path.join(swarmcraftSrc, "embed.css");
  }
  return alias;
}

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  base: "/",
  publicDir: "public",
  build: {
    outDir: path.resolve(__dirname, "../../dist/web"),
    emptyOutDir: true,
    // Default to no sourcemaps so production builds don't ship ~17 MB of
    // .map files to end users. Set VITE_BUILD_SOURCEMAP=true to re-enable
    // when debugging a production bundle.
    sourcemap: process.env.VITE_BUILD_SOURCEMAP === "true",
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
    alias: buildResolveAlias(),
  },
  server: {
    port: devPort,
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

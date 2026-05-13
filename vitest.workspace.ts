import { defineWorkspace } from "vitest/config";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";

// Shared source-alias resolution for the web project. Mirrors the dev-time
// aliases in src/web/vite.config.ts so vitest can resolve `openteams-editor`
// and `swarmcraft/ui/embed` to the references/ source tree (live-edit dev),
// falling through to the published packages when references/ isn't populated.
const swarmcraftSrc = path.resolve(__dirname, "references/swarmcraft/src/ui");
const openteamsEditorSrc = path.resolve(__dirname, "references/openteams/editor/src");

const webAlias: { find: string | RegExp; replacement: string }[] = [
  { find: "@", replacement: path.resolve(__dirname, "src/web") },
];
if (fs.existsSync(path.join(swarmcraftSrc, "embed.ts"))) {
  webAlias.push({ find: "swarmcraft/ui/embed.css", replacement: path.join(swarmcraftSrc, "embed.css") });
  webAlias.push({ find: "swarmcraft/ui/embed", replacement: path.join(swarmcraftSrc, "embed.ts") });
}
if (fs.existsSync(path.join(openteamsEditorSrc, "index.ts"))) {
  webAlias.push({ find: "openteams-editor/styles.css", replacement: path.join(openteamsEditorSrc, "index.css") });
  webAlias.push({ find: /^openteams-editor$/, replacement: path.join(openteamsEditorSrc, "index.ts") });
}

export default defineWorkspace([
  {
    // Server project: node env, sequential file runs (DB singletons),
    // covers everything under src/ except src/web/**.
    resolve: {
      // Resolve file: linked packages (e.g., @openhive/types) through symlinks.
      preserveSymlinks: false,
    },
    test: {
      name: "server",
      globals: true,
      environment: "node",
      include: ["src/**/*.{test,spec}.{js,ts}"],
      exclude: ["**/node_modules/**", "**/dist/**", "src/web/**"],
      fileParallelism: false,
      coverage: {
        provider: "v8",
        reporter: ["text", "json", "html"],
        exclude: [
          "node_modules/**",
          "dist/**",
          "src/web/**",
          "**/*.d.ts",
          "**/*.test.ts",
          "**/*.spec.ts",
        ],
      },
      testTimeout: 30000,
      watch: false,
    },
  },
  {
    // Web project: jsdom env, react plugin, source-alias resolution
    // matching src/web/vite.config.ts.
    plugins: [react()],
    resolve: { alias: webAlias },
    test: {
      name: "web",
      globals: true,
      environment: "jsdom",
      setupFiles: ["./src/web/__tests__/setup.ts"],
      include: ["src/web/**/*.{test,spec}.{ts,tsx}"],
      exclude: ["**/node_modules/**", "**/dist/**"],
      css: false,
    },
  },
]);

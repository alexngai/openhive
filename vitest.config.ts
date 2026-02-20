import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolve file: linked packages (e.g., @openhive/types) through symlinks
    preserveSymlinks: false,
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.{test,spec}.{js,ts}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Run test files sequentially to avoid database singleton conflicts
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
});

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/web"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/web/__tests__/setup.ts"],
    include: ["src/web/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    css: false,
  },
});

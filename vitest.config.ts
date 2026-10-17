import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@shared": path.resolve(import.meta.dirname, "server/src/shared") },
  },
  test: {
    include: ["server/src/**/*.test.ts", "web/src/**/*.test.{ts,tsx}", "site/src/**/*.test.ts"],
    // Component tests (web/src/**/*.test.tsx) ask for jsdom themselves with `// @vitest-environment jsdom`.
    environment: "node",
  },
});

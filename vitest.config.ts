import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/src/**/*.test.ts", "web/src/**/*.test.ts"],
    environment: "node",
  },
});

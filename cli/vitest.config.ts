import { defineConfig } from "vitest/config";

// Unit tests for the CLI's pure helpers (src/**/*.test.ts): no network, no keys, no built component.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});

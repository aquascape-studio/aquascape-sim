import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    // keep the perf budget meaningful: no CPU contention between test files
    fileParallelism: false,
  },
});

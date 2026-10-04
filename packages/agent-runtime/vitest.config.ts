import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Avoid starving SDK-heavy fixtures without relaxing their timeout.
    maxWorkers: Math.min(4, availableParallelism()),
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,cache,output,temp}/**",
    ],
  },
});

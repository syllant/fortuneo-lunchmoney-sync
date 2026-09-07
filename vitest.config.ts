import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/v2/**/*.test.ts"],
    coverage: { include: ["packages/shared/src/**/*.ts", "packages/native-host/src/**/*.ts"] },
  },
});

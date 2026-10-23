import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/normalize.test.ts", "test/similarity.test.ts", "test/ranking.test.ts", "test/limits.test.ts"],
    browser: { enabled: true, provider: "playwright", name: "chromium", headless: true },
  },
});

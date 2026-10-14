import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    ATGEO_SERVER: JSON.stringify(process.env.ATGEO_SERVER ?? "http://localhost:8000"),
    ATGEO_DATASET: JSON.stringify(process.env.ATGEO_DATASET ?? "openstreetmap.org"),
    ATGEO_COLLECTION: JSON.stringify(process.env.ATGEO_COLLECTION),
    ATGEO_REGION: JSON.stringify(process.env.ATGEO_REGION ?? "43.0,-71.45,3000"),
  },
  test: {
    include: ["scripts/e2e.browser.ts"],
    browser: { enabled: true, provider: "playwright", name: "chromium", headless: true },
  },
});

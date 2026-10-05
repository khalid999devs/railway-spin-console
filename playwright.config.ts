import { defineConfig, devices } from "@playwright/test";

const PORT = 3299;

/**
 * One pass through the main flow at phone width, against the production
 * build running with the in-memory Railway. No token and no network needed.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices["Pixel 7"],
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run build && npm run preview",
    url: `http://127.0.0.1:${PORT}/api/health`,
    env: { RAILWAY_FAKE: "1", PORT: String(PORT), HOSTNAME: "127.0.0.1" },
    reuseExistingServer: false,
    timeout: 180_000,
  },
});

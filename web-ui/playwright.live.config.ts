import { defineConfig } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_LIVE_BASE_URL || "http://192.168.50.254";

export default defineConfig({
  testDir: "./tests/e2e-live",
  globalSetup: "./tests/e2e-live/globalSetup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1, // Single engine slot — parallel live tests would queue and lie
  timeout: 900000, // 15 minutes max per scenario
  reporter: [
    ["list"],
    ["json", { outputFile: "playwright-live-report/results.json" }]
  ],
  use: {
    baseURL: BASE_URL,
    defaultBrowserType: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    viewport: { width: 1280, height: 900 },
    actionTimeout: 15000,
    navigationTimeout: 30000
  },
  projects: [
    {
      name: "live-desktop",
      use: {
        viewport: { width: 1280, height: 900 }
      }
    }
  ]
});

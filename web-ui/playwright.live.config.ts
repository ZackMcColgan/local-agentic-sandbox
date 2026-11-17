import { defineConfig } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_LIVE_BASE_URL || "http://192.168.50.254";

export default defineConfig({
  testDir: "./tests/e2e-live",
  globalSetup: "./tests/e2e-live/globalSetup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1, // Single engine slot — parallel live tests would queue and lie
  globalTimeout: 75 * 60 * 1000, // §5: 75 minutes wall-clock hard abort
  timeout: 900000, // Default fallback 15 min
  outputDir: "./test-results-live",
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
      name: "L1-short-flow",
      testMatch: /l1-short-flow-copy\.spec\.ts/,
      timeout: 6 * 60 * 1000 // §1: 6 min
    },
    {
      name: "L2-artifacts-downloads",
      testMatch: /l2-artifacts-downloads\.spec\.ts/,
      timeout: 8 * 60 * 1000 // §1: 8 min
    },
    {
      name: "L3-compaction-numbers",
      testMatch: /l3-compaction-numbers\.spec\.ts/,
      timeout: 15 * 60 * 1000 // §1: 15 min
    },
    {
      name: "L4-steer-reload-resilience",
      testMatch: /l4-steer-reload-resilience\.spec\.ts/,
      timeout: 15 * 60 * 1000 // §1: 15 min
    },
    {
      name: "L5-host-multi-slice",
      testMatch: /l5-host-multi-slice\.spec\.ts/,
      timeout: 8 * 60 * 1000 // §1: 8 min
    },
    {
      name: "L6-long-generation",
      testMatch: /l6-long-generation\.spec\.ts/,
      timeout: 12 * 60 * 1000 // §1: 12 min
    },
    {
      name: "L7-host-stress",
      testMatch: /l7-host-stress\.spec\.ts/,
      timeout: 10 * 60 * 1000 // §1: 10 min
    },
    {
      name: "L8-wedge-regression",
      testMatch: /l8-wedge-regression\.spec\.ts/,
      timeout: 15 * 60 * 1000 // §1: 15 min
    }
  ]
});

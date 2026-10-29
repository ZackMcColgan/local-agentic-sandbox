import { defineConfig } from "@playwright/test";

const PORT = process.env.PORT || "3005";
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  snapshotDir: "./tests/e2e/__snapshots__",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
    ["json", { outputFile: "playwright-report/test-results.json" }]
  ],
  use: {
    baseURL: BASE_URL,
    defaultBrowserType: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10000,
    navigationTimeout: 15000,
  },
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.08,
      animations: "disabled",
    },
  },
  projects: [
    {
      name: "mobile-light",
      use: {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        defaultBrowserType: "chromium",
        colorScheme: "light",
      },
    },
    {
      name: "mobile-dark",
      use: {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        defaultBrowserType: "chromium",
        colorScheme: "dark",
      },
    },
    {
      name: "desktop-light",
      use: {
        viewport: { width: 1440, height: 900 },
        hasTouch: false,
        isMobile: false,
        defaultBrowserType: "chromium",
        colorScheme: "light",
      },
    },
    {
      name: "desktop-dark",
      use: {
        viewport: { width: 1440, height: 900 },
        hasTouch: false,
        isMobile: false,
        defaultBrowserType: "chromium",
        colorScheme: "dark",
      },
    },
  ],
  ...(process.env.PLAYWRIGHT_BASE_URL
    ? {}
    : {
        webServer: {
          command: `npm run start -- -p ${PORT}`,
          url: `http://127.0.0.1:${PORT}`,
          reuseExistingServer: !process.env.CI,
          timeout: 60000,
        },
      }),
});

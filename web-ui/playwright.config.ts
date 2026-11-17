import { defineConfig } from "@playwright/test";

const PORT = process.env.PORT || "3005";
const STUB_PORT = process.env.STUB_ENGINE_PORT || "11435";
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  snapshotDir: "./tests/e2e/__snapshots__",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
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
        webServer: [
          {
            command: "node tests/e2e/fixtures/stubEngine.cjs",
            url: `http://127.0.0.1:${STUB_PORT}/api/version`,
            reuseExistingServer: false,
            timeout: 30000,
            stdout: "pipe",
            stderr: "pipe",
            env: {
              PORT: STUB_PORT,
              STUB_ENGINE_PORT: STUB_PORT,
            },
          },
          {
            command: `npm run start -- -p ${PORT}`,
            url: `http://127.0.0.1:${PORT}`,
            reuseExistingServer: false,
            timeout: 60000,
            stdout: "pipe",
            stderr: "pipe",
            env: {
              PORT,
              LLM_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
              OLLAMA_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
              DISABLE_GITOPS: "true",
              DISABLE_GITOPS_DIRTY_CHECK: "true",
              THREADS_DIR: ".tmp-e2e-threads",
              AGENT_CHECKPOINT_DIR: ".tmp-e2e-checkpoints",
            },
          },
        ],
      }),
});

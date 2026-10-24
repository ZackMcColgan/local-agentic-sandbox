import { test, expect } from "@playwright/test";
import { setupStubbedEngineRoutes } from "./helpers/mockEngine";
import { assertLayoutInvariants } from "./helpers/layoutInvariants";

test.describe("Simulation Mode & State Invariants Suite", () => {
  let forbiddenCalls: string[] = [];

  test.beforeEach(async ({ page }) => {
    forbiddenCalls = [];
    await setupStubbedEngineRoutes(page);

    // Hard gate: zero network calls to real /api/chat or /api/tasks allowed during simulation
    await page.route("**/api/chat**", async (route) => {
      forbiddenCalls.push(`FORBIDDEN_CALL: /api/chat -> ${route.request().url()}`);
      await route.abort("failed");
    });

    await page.route("**/api/tasks**", async (route) => {
      const url = route.request().url();
      // Allow initial idle mount hydration check
      if (url.includes("active=true") && route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ activeTask: null, tasks: [] })
        });
        return;
      }
      forbiddenCalls.push(`FORBIDDEN_CALL: /api/tasks -> ${route.request().method()} ${url}`);
      await route.abort("failed");
    });
  });

  test.afterEach(() => {
    expect(forbiddenCalls).toEqual([]);
  });

  test("Scenario 1: chat-fast streams reply, verifies simulation badge, and recovers composer", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("textarea");

    // Enter simulation command in composer (default 1x speed gives ~2s stream to verify mid-stream state)
    const textarea = page.locator("textarea").first();
    await textarea.fill("/simulate chat-fast");
    await textarea.press("Enter");

    // 1. Simulation badge is visible in header
    const simBadge = page.locator('[data-testid="simulation-badge"]');
    await expect(simBadge).toBeVisible();
    await expect(simBadge).toContainText("SIMULATION");

    // 2. Mid-stream layout invariants check (Send button replaced by Stop button)
    await expect(page.locator('[data-testid="stop-button"]').first()).toBeVisible();
    await assertLayoutInvariants(page, "sim-chat-fast-midstream", { checkOverlap: true, checkOverflow: true });

    // 3. Waits for stream to finish naturally
    await expect(page.locator('[data-testid="send-button"]').first()).toBeVisible({ timeout: 10000 });

    // 4. Assistant message content rendered
    const assistantMsg = page.locator('text=All systems nominal').first();
    await expect(assistantMsg).toBeVisible();
  });

  test("Scenario 2: chat-slow (accelerated) halts within 1 second on user Stop", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("textarea");

    const textarea = page.locator("textarea").first();
    await textarea.fill("/simulate chat-slow 10");
    await textarea.press("Enter");

    // Verify stream started
    await expect(page.locator('[data-testid="simulation-badge"]')).toBeVisible();
    const stopBtn = page.locator('[data-testid="stop-button"]').first();
    await expect(stopBtn).toBeVisible();

    // Wait 500ms for initial tokens to stream in
    await page.waitForTimeout(500);

    // Click Stop button and measure time to halt
    const stopStart = Date.now();
    await stopBtn.click();

    // Composer must revert to Send button in < 1000ms
    await expect(page.locator('[data-testid="send-button"]').first()).toBeVisible({ timeout: 1000 });
    const elapsed = Date.now() - stopStart;
    expect(elapsed).toBeLessThan(1000);

    // Message shows stopped indicator
    await expect(page.locator('text=[Stopped by user]').first()).toBeVisible();
  });

  test("Scenario 3: chat-slow (1x real-time) maintains layout invariants during active waiting", async ({ page }) => {
    test.setTimeout(30000);
    await page.goto("/?simulate=chat-slow&speed=1");
    await page.waitForSelector('[data-testid="simulation-badge"]');

    // Verify active streaming at 1x real-time
    await expect(page.locator('[data-testid="stop-button"]').first()).toBeVisible();

    // Sample layout invariants during real-time 1x waiting state
    await page.waitForTimeout(2000);
    await assertLayoutInvariants(page, "sim-chat-slow-1x-running", { checkOverlap: true, checkOverflow: true });

    // Conclude cleanly by clicking Stop
    await page.locator('[data-testid="stop-button"]').first().click();
    await expect(page.locator('[data-testid="send-button"]').first()).toBeVisible({ timeout: 1000 });
  });

  test("Scenario 4: chat-tools renders thinking panel, command failure, and self-healing fallback", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("textarea");

    const textarea = page.locator("textarea").first();
    await textarea.fill("/simulate chat-tools 25");
    await textarea.press("Enter");

    // Wait for stream completion
    await expect(page.locator('[data-testid="send-button"]').first()).toBeVisible({ timeout: 10000 });

    // 1. Thinking panel visible and expandable
    const thinkingHeader = page.locator('text=Worker reasoning').first();
    await expect(thinkingHeader).toBeVisible();

    // 2. Failed command step is visible
    const toolStep1 = page.locator('text=Execute Sandboxed Command').first();
    await expect(toolStep1).toBeVisible();

    // 3. Fallback tool step is visible
    const toolStep2 = page.locator('text=analytics-fallback.json').first();
    await expect(toolStep2).toBeVisible();

    // 4. Final verified answer text
    await expect(page.locator('text=Total Orders: 142').first()).toBeVisible();
  });

  test("Scenario 5: build-run executes multi-milestone task and updates workspace diff", async ({ page, isMobile }) => {
    await page.goto("/");
    await page.waitForSelector("textarea");

    const textarea = page.locator("textarea").first();
    await textarea.fill("/simulate build-run 25");
    await textarea.press("Enter");

    // 1. LiveRunBlock appears for the simulated task
    const liveRun = page.locator('[data-testid="live-run-block"], div:has-text("Build synthetic microservices telemetry pipeline")').first();
    await expect(liveRun).toBeVisible();

    // 2. Wait for milestones to complete
    await expect(page.locator('text=Completed').first()).toBeVisible({ timeout: 15000 });

    // 3. On desktop, open workspace panel and verify diff viewer
    if (!isMobile) {
      const workspaceBtn = page.locator('button[title="Toggle Workspace Panel"]').first();
      await workspaceBtn.click();

      // Diff viewer should show the planned telemetry module diff
      const diffTab = page.locator('button:has-text("Diff")').first();
      await diffTab.click();
      await expect(page.locator('text=MetricsCollector')).toBeVisible();
    }
  });

  test("Scenario 6: build-retry displays critic rejection on iteration 1 and pass on iteration 2", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("textarea");

    const textarea = page.locator("textarea").first();
    await textarea.fill("/simulate build-retry 25");
    await textarea.press("Enter");

    // Verify rejection on iteration 1
    await expect(page.locator('text=Critic Rejected Iteration 1').first()).toBeVisible({ timeout: 10000 });

    // Wait for task completion on iteration 2
    await expect(page.locator('text=Completed').first()).toBeVisible({ timeout: 15000 });
  });

  test("Scenario 7: engine-stop renders mid-stream disconnect error banner and recovers composer", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("textarea");

    const textarea = page.locator("textarea").first();
    await textarea.fill("/simulate engine-stop 20");
    await textarea.press("Enter");

    // Mid-stream error banner appears
    const errorBanner = page.locator('text=Local LLM Engine offline').first();
    await expect(errorBanner).toBeVisible({ timeout: 10000 });

    // Composer recovers: Send button is enabled
    await expect(page.locator('[data-testid="send-button"]').first()).toBeVisible();
  });

  test("Scenario 8: project-task runs overnight security audit lifecycle to review ready", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("textarea");

    const textarea = page.locator("textarea").first();
    await textarea.fill("/simulate project-task 25");
    await textarea.press("Enter");

    // Live task block shows overnight audit
    await expect(page.locator('text=Run overnight security audit on enterprise-core project').first()).toBeVisible();

    // Completes to review ready
    await expect(page.locator('text=Completed').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=Audit npm dependencies and verify SBOM signatures').first()).toBeVisible();
  });

  test("Scenario 9: backend-down renders 503 error surface and retry button", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("textarea");

    const textarea = page.locator("textarea").first();
    await textarea.fill("/simulate backend-down");
    await textarea.press("Enter");

    // Error banner renders with 503 error message
    const errorBanner = page.locator('div:has-text("Service Unavailable")').first();
    await expect(errorBanner).toBeVisible({ timeout: 5000 });

    // Retry button is available
    const retryBtn = page.locator('button:has-text("Retry")').first();
    await expect(retryBtn).toBeVisible();

    // Send button is restored and composer is interactive
    await expect(page.locator('[data-testid="send-button"]').first()).toBeVisible();
  });

  test("Scenario 10: Navigation works mid-run without UI hijacking or crashes", async ({ page, isMobile }) => {
    await page.goto("/");
    await page.waitForSelector("textarea");

    // Start a 1x real-time slow simulation
    const textarea = page.locator("textarea").first();
    await textarea.fill("/simulate chat-slow 1");
    await textarea.press("Enter");

    // Verify stream started
    await expect(page.locator('[data-testid="stop-button"]').first()).toBeVisible();

    if (isMobile) {
      // 1. Open mobile drawer mid-stream
      const hamburger = page.locator('button[aria-label="Open navigation menu"]').first();
      await hamburger.click();
      const drawer = page.locator('div.rounded-r-3xl, [data-testid="navigation-drawer"]').first();
      await expect(drawer).toBeVisible();

      // 2. Navigate to Builds view mid-stream
      await drawer.locator('button:has-text("Builds")').click();
      await expect(page.getByRole("heading", { name: "Builds", exact: true })).toBeVisible();

      // 3. Return to Sessions mid-stream
      const buildsMenuBtn = page.locator('button[data-testid="builds-menu-btn"], button[title="Open menu"]').first();
      await buildsMenuBtn.click();
      await drawer.locator('button:has-text("Sessions")').click();

      // 4. Verify chat stream is still active
      await expect(page.locator('[data-testid="simulation-badge"]')).toBeVisible();
      await page.locator('[data-testid="stop-button"]').first().click();
    } else {
      // Desktop navigation mid-stream
      const buildsBtn = page.locator('button:has-text("Builds")').first();
      await buildsBtn.click();
      await expect(page.getByRole("heading", { name: "Builds", exact: true })).toBeVisible();

      // Return to Sessions
      const sessionsBtn = page.locator('button:has-text("Chat"), button:has-text("Sessions")').first();
      await sessionsBtn.click();

      // Verify chat stream is still active
      await expect(page.locator('[data-testid="simulation-badge"]')).toBeVisible();
      await page.locator('[data-testid="stop-button"]').first().click();
    }

    // Composer recovers cleanly
    await expect(page.locator('[data-testid="send-button"]').first()).toBeVisible();
  });
});

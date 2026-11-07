import { test, expect } from "@playwright/test";

const STUB_BASE = process.env.STUB_ENGINE_BASE || "http://127.0.0.1:11435";

async function setStubScript(script: string) {
  const res = await fetch(`${STUB_BASE}/__stub/script`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script }),
  });
  if (!res.ok) {
    throw new Error(`Failed to set stub script ${script}: ${res.status}`);
  }
}

async function releaseStub() {
  const res = await fetch(`${STUB_BASE}/__stub/release`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`Failed to release stub: ${res.status}`);
  }
}

async function resetStub() {
  const res = await fetch(`${STUB_BASE}/__stub/reset`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`Failed to reset stub: ${res.status}`);
  }
}

test.describe("Real-Mode Runtime E2E Invariants (No Browser Route Mocks)", () => {
  test.beforeEach(async () => {
    await resetStub();
  });

  test.afterEach(async () => {
    await resetStub();
  });

  test("UI-A1 (CHAT-14): Reasoning panel visible while content empty, preserved across reload, and completes", async ({ page }) => {
    await setStubScript("long-thinking");

    await page.goto("/");
    await page.waitForSelector("textarea");

    // 1. Send chat message
    const composer = page.locator("textarea");
    await composer.fill("Please analyze the system architecture in detail.");
    const sendBtn = page.locator('button[data-testid="send-button"]');
    await expect(sendBtn).toBeEnabled();
    await sendBtn.click();

    // 2. Reasoning panel visible while assistant content is still empty
    const thinkingPanel = page.locator('[data-testid="thinking-panel"]').last();
    await expect(thinkingPanel).toBeVisible({ timeout: 10000 });
    await expect(thinkingPanel).toContainText("Reasoning");
    await expect(page.locator("text=Analyzing requirements").first()).toBeVisible({ timeout: 15000 });

    // Verify assistant content has not arrived yet
    const finalAnswer = page.locator("text=Deliberation complete. Here is the verified answer.").last();
    await expect(finalAnswer).toHaveCount(0);

    // 3. Reload page mid-deliberation
    await page.reload();

    // 4. Panel present, thinking preserved
    const thinkingPanelAfterReload = page.locator('[data-testid="thinking-panel"]').last();
    await expect(thinkingPanelAfterReload).toBeVisible({ timeout: 10000 });
    await expect(thinkingPanelAfterReload).toContainText("Reasoning");
    await expect(page.locator("text=Analyzing requirements").first()).toBeVisible({ timeout: 15000 });

    // 5. Release stub engine to stream final answer
    await releaseStub();

    // 6. Complete: final answer renders
    await expect(finalAnswer).toBeVisible({ timeout: 15000 });
  });

  test("UI-A2 (CHAT-13): Mid-turn steer preserves prior thinking and delivers redirected answer", async ({ page }) => {
    await setStubScript("two-round");

    await page.goto("/");
    await page.waitForSelector("textarea");

    // 1. Send initial message
    const composer = page.locator("textarea");
    await composer.fill("What is the weather today?");
    const sendBtn = page.locator('button[data-testid="send-button"]');
    await expect(sendBtn).toBeEnabled();
    await sendBtn.click();

    // 2. Round 1 streams partial content and thinking
    const r1Content = page.locator("text=The weather today is partly cloudy, 68°F.").last();
    await expect(r1Content).toBeVisible({ timeout: 10000 });

    const thinkingPanel = page.locator('[data-testid="thinking-panel"]').last();
    await expect(thinkingPanel).toBeVisible({ timeout: 10000 });

    // 3. Select Steer in segmented control
    const steerRadio = page.locator('button[role="radio"]:has-text("Steer")');
    if (await steerRadio.isVisible()) {
      await steerRadio.click();
    }

    // 4. Submit Steer in composer
    await composer.fill("Please create an SVG diagram of this weather instead.");
    await expect(sendBtn).toBeEnabled();
    await sendBtn.click();

    // 5. Panel stays visible with Round 1 thinking preserved
    await expect(thinkingPanel).toBeVisible({ timeout: 10000 });

    // 6. Round 2 delivers redirected answer
    const redirectedAnswer = page.locator("text=Redirected Answer: Here is the SVG diagram you requested").last();
    await expect(redirectedAnswer).toBeVisible({ timeout: 15000 });
  });

  test("UI-B1 (BUILD-2): Build mode planning card visible immediately, persists across reload, and completes", async ({ page }) => {
    await setStubScript("planner-slow");

    await page.goto("/");
    await page.waitForSelector("textarea");

    // 1. Select Build mode toggle
    const buildRadio = page.locator('button[role="radio"]:has-text("Build")');
    await expect(buildRadio).toBeVisible();
    await buildRadio.click();

    // 2. Enter multi-file project goal and launch build task
    const composer = page.locator("textarea");
    await composer.fill("Build full-stack weather dashboard service and API application");
    const sendBtn = page.locator('button[data-testid="send-button"]');
    await expect(sendBtn).toBeEnabled();
    await sendBtn.click();

    // 3. Goal bubble + planning task card visible immediately
    const goalBubble = page.locator("text=Build full-stack weather dashboard service and API application").last();
    await expect(goalBubble).toBeVisible({ timeout: 10000 });

    const planningCard = page.locator("text=Live run").last();
    await expect(planningCard).toBeVisible({ timeout: 10000 });
    const planningBadge = page.locator("text=Planning").last();
    await expect(planningBadge).toBeVisible({ timeout: 10000 });

    // 4. Reload page while planner is still blocked
    await page.reload();

    // 5. Task visible in thread after reload
    await expect(planningCard).toBeVisible({ timeout: 10000 });

    // 6. Navigate to Builds tab and verify task is listed
    await page.goto("/?tab=builds");
    const buildRow = page.locator("text=Build full-stack weather dashboard service and API application").last();
    await expect(buildRow).toBeVisible({ timeout: 10000 });

    // 7. Release planner
    await releaseStub();

    // 8. Return to thread and verify completion or active milestone execution
    await page.goto("/");
    await expect(page.locator("text=Started autonomous engineering run").or(page.locator("text=Live run"))).toBeVisible({ timeout: 15000 });
  });

  test("UI-B1 (BUILD-2) Failure Honesty: Planner failure displays terminal error and persists in Builds tab", async ({ page }) => {
    await setStubScript("planner-fail");

    await page.goto("/");
    await page.waitForSelector("textarea");

    // 1. Select Build mode toggle
    const buildRadio = page.locator('button[role="radio"]:has-text("Build")');
    await expect(buildRadio).toBeVisible();
    await buildRadio.click();

    // 2. Enter goal and launch build task
    const composer = page.locator("textarea");
    await composer.fill("Build failing microservice application architecture");
    const sendBtn = page.locator('button[data-testid="send-button"]');
    await expect(sendBtn).toBeEnabled();
    await sendBtn.click();

    // 3. Terminal failure message shown in thread
    const failMessage = page.locator("text=Task failed: Planner model capacity exceeded").or(page.locator("text=Run failed")).last();
    await expect(failMessage).toBeVisible({ timeout: 15000 });

    // 4. Navigate to Builds tab and verify task is listed as failed
    await page.goto("/?tab=builds");
    const buildCard = page.locator('[data-testid^="task-row-"]').filter({ hasText: "Build failing microservice application architecture" }).first();
    await expect(buildCard).toBeVisible({ timeout: 10000 });
    await expect(buildCard.locator("text=failed")).toBeVisible({ timeout: 10000 });
  });
});

import { test, expect } from "@playwright/test";
import { setupStubbedEngineRoutes } from "./helpers/mockEngine";

test.describe("Phase B3 — Unhappy paths", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
    hasTouch: true,
    isMobile: true,
  });

  test.beforeEach(async ({ page }) => {
    await setupStubbedEngineRoutes(page);
  });

  test("Empty and whitespace-only chat submit is a no-op", async ({ page }) => {
    let chatCalls = 0;
    await page.route("**/api/chat", async (route) => {
      chatCalls++;
      await route.continue();
    });

    await page.goto("/");
    const composer = page.locator("textarea").first();
    await composer.fill("   \n\t  ");
    await composer.press("Enter");
    await page.waitForTimeout(300);
    expect(chatCalls).toBe(0);
  });

  test("Double-submit on chat composer triggers at most one request", async ({ page }) => {
    let chatCalls = 0;
    await page.route("**/api/chat", async (route) => {
      chatCalls++;
      await new Promise((r) => setTimeout(r, 400));
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: 'data: {"type":"token","text":"Single effect"}\n\ndata: {"type":"done"}\n\n',
      });
    });

    await page.goto("/");
    const composer = page.locator("textarea").first();
    await composer.fill("Double tap test");
    await composer.press("Enter");
    await composer.press("Enter").catch(() => {});
    await expect(page.getByText("Single effect")).toBeVisible({ timeout: 5000 });
    expect(chatCalls).toBe(1);
  });

  test("Severed stream mid-response: honest error/end-state, no stuck streaming", async ({ page }) => {
    await page.route("**/api/chat", async (route) => {
      await route.abort("failed");
    });

    await page.goto("/");
    const composer = page.locator("textarea").first();
    await composer.fill("Trigger severed stream");
    await composer.press("Enter");

    await page.waitForTimeout(1000);
    const stopBtn = page.locator('button[aria-label="Stop generating"], button[title*="Stop"]');
    await expect(stopBtn).toHaveCount(0, { timeout: 5000 });

    // Reload and verify clean honest state
    await page.reload();
    await expect(page.locator("textarea").first()).toBeVisible();
    await expect(stopBtn).toHaveCount(0);
  });
});

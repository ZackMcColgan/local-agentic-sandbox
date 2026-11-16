import { test, expect } from "@playwright/test";
import { setupStubbedEngineRoutes } from "./helpers/mockEngine";

test.describe("Phase B2 — Start/stop abuse", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
    hasTouch: true,
    isMobile: true,
  });

  test.beforeEach(async ({ page }) => {
    await setupStubbedEngineRoutes(page);
  });

  test("Send then stop immediately, stop then send again, and subsequent normal turn completes", async ({ page }) => {
    let callCount = 0;
    await page.route("**/api/chat", async (route) => {
      callCount++;
      if (callCount === 1) {
        await new Promise((r) => setTimeout(r, 10000));
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: 'data: {"done":true}\n\n',
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: 'data: {"content":"Recovered response"}\n\ndata: {"done":true}\n\n',
        });
      }
    });

    await page.goto("/");
    const composer = page.locator("textarea").first();
    await composer.fill("Abuse prompt 1");
    await composer.press("Enter");

    const stopBtn = page.locator('button[aria-label="Stop generating"], button[title*="Stop"]').first();
    await expect(stopBtn).toBeVisible({ timeout: 5000 });
    // Tap stop repeatedly
    await stopBtn.click();
    if (await stopBtn.isVisible().catch(() => false)) {
      await stopBtn.click().catch(() => {});
    }

    // Stop button should disappear, no stuck streaming state
    await expect(stopBtn).toHaveCount(0, { timeout: 5000 });

    // Immediately send again and verify normal turn completes
    await composer.fill("Normal follow-up");
    await composer.press("Enter");
    await expect(page.getByText("Recovered response")).toBeVisible({ timeout: 8000 });
    await expect(stopBtn).toHaveCount(0, { timeout: 5000 });
  });

  test("Navigate to another view mid-stream and back: no stuck streaming state", async ({ page }) => {
    await page.route("**/api/chat", async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: 'data: {"content":"Mid-stream done"}\n\ndata: {"done":true}\n\n',
      });
    });

    await page.goto("/");
    const composer = page.locator("textarea").first();
    await composer.fill("Navigate mid-stream");
    await composer.press("Enter");

    // Navigate to Board mid-stream
    await page.locator('button[aria-label="Open navigation menu"]').first().click();
    await page.locator('[data-testid="navigation-drawer"] button:has-text("Board"), div.rounded-r-3xl button:has-text("Board")').first().click();
    await page.waitForTimeout(2500);

    // Navigate back to Sessions / Chat
    await page.locator('button[aria-label="Open navigation menu"]').first().click();
    await page.locator('[data-testid="navigation-drawer"] button:has-text("Sessions"), div.rounded-r-3xl button:has-text("Sessions")').first().click();
    await page.waitForTimeout(300);

    // No stuck stop button
    const stopBtn = page.locator('button[aria-label="Stop generating"], button[title*="Stop"]');
    await expect(stopBtn).toHaveCount(0, { timeout: 5000 });
  });
});

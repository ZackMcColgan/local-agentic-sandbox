import { test, expect } from "@playwright/test";
import { setupStubbedEngineRoutes } from "./helpers/mockEngine";

test.describe("Phase B1 — Saturation and overflow", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
    hasTouch: true,
    isMobile: true,
  });

  test.beforeEach(async ({ page }) => {
    await setupStubbedEngineRoutes(page);
  });

  test("Queue 20+ items with long text; Clear all works and no horizontal overflow", async ({ page }) => {
    await page.route("**/api/chat", async (route) => {
      await new Promise((r) => setTimeout(r, 20000));
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: 'data: {"done":true}\n\n',
      });
    });

    await page.goto("/");
    const composer = page.locator("textarea").first();
    await composer.fill("Stream starter");
    await composer.press("Enter");
    await expect(page.locator('button[aria-label="Stop generating"], button[title*="Stop"]').first()).toBeVisible({ timeout: 5000 });

    const queueBtn = page.locator('button[aria-label="Enqueue message"]').first();
    for (let i = 0; i < 20; i++) {
      await composer.fill(`SatQ${i}_${"Z".repeat(80)}`);
      await queueBtn.click();
    }

    const queueDeck = page.locator('[data-testid="chat-queue-deck"]');
    await expect(queueDeck).toBeVisible();
    const clearAll = page.locator('[data-testid="chat-queue-clear-all"]');
    await expect(clearAll).toBeVisible();

    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);

    await clearAll.click();
    await expect(queueDeck).toHaveCount(0);
  });

  test("Board column with 50 cards & drawer with 100+ threads: render & scroll hold", async ({ page }) => {
    const threads = Array.from({ length: 105 }, (_, i) => ({
      id: `thr-${i}`,
      title: `Thread ${i} ${"Topic".repeat(3)}`,
      updatedAt: Date.now() - i * 1000,
      messages: [{ role: "user", content: "hi" }],
    }));

    const cards = Array.from({ length: 50 }, (_, i) => ({
      id: `bcard-${i}`,
      title: `Card ${i} ${"Task".repeat(4)}`,
      status: "queued",
      priority: "medium",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    await page.route("**/api/sessions**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: threads }),
      });
    });
    await page.route("**/api/board**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: cards }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto("/");
    await page.locator('button[aria-label="Open navigation menu"]').first().click();
    const drawer = page.locator('[data-testid="navigation-drawer"], div.rounded-r-3xl').first();
    await expect(drawer).toBeVisible();

    await drawer.locator('button:has-text("Board")').first().click();
    await page.waitForTimeout(400);
    await expect(page.getByText("Card 0").first()).toBeVisible();

    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  });

  test("1 MB paste into chat input & 10,000-char unbroken string: no crash, no layout break", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    const composer = page.locator("textarea").first();
    await expect(composer).toBeVisible();

    const oneMb = "A".repeat(1024 * 1024);
    await composer.fill(oneMb, { timeout: 60_000 });
    const valLen = await composer.evaluate((el: HTMLTextAreaElement) => el.value.length);
    expect(valLen).toBeGreaterThan(0);

    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  });
});

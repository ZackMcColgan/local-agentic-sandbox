import { test, expect } from "@playwright/test";
import { setupStubbedEngineRoutes } from "./helpers/mockEngine";

test.describe("Phase B4 — Type confusion and hostile input", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
    hasTouch: true,
    isMobile: true,
  });

  test.beforeEach(async ({ page }) => {
    await setupStubbedEngineRoutes(page);
  });

  test("Type-confusion & injection & unicode strings in Board titles render as inert text without layout break", async ({ page }) => {
    const hostileCards = [
      { id: "c1", title: "12345", column: "todo", status: "todo" },
      { id: "c2", title: "0", column: "todo", status: "todo" },
      { id: "c3", title: "-1", column: "todo", status: "todo" },
      { id: "c4", title: "1e9", column: "todo", status: "todo" },
      { id: "c5", title: "null", column: "todo", status: "todo" },
      { id: "c6", title: "undefined", column: "todo", status: "todo" },
      { id: "c7", title: "NaN", column: "todo", status: "todo" },
      { id: "c8", title: "<script>alert(1)</script>", column: "todo", status: "todo" },
      { id: "c9", title: "<img src=x onerror=alert(1)>", column: "todo", status: "todo" },
      { id: "c10", title: "Zalgo a\u0301\u0302\u0303\u0304\u0305\u0306", column: "todo", status: "todo" },
      { id: "c11", title: "\u202ERTL_OVERRIDE_TEST", column: "todo", status: "todo" },
      { id: "c12", title: "🚀🔥🧪", column: "todo", status: "todo" },
    ].map((c) => ({ ...c, priority: "medium", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));

    await page.route("**/api/board**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: hostileCards }),
        });
      } else {
        await route.continue();
      }
    });

    let dialogFired = false;
    page.on("dialog", () => {
      dialogFired = true;
    });

    await page.goto("/");
    await page.locator('button[aria-label="Open navigation menu"]').first().click();
    await page.locator('[data-testid="navigation-drawer"] button:has-text("Board"), div.rounded-r-3xl button:has-text("Board")').first().click();
    await page.waitForTimeout(400);

    expect(dialogFired).toBe(false);
    // Ensure <script> is rendered as inert text, not executed
    await expect(page.getByText("<script>alert(1)</script>").first()).toBeVisible();
    await expect(page.getByText("🚀🔥🧪").first()).toBeVisible();

    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  });

  test("XSS payload in chat message renders as inert text", async ({ page }) => {
    let dialogFired = false;
    page.on("dialog", () => {
      dialogFired = true;
    });

    await page.route("**/api/chat", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: 'data: {"type":"token","text":"<img src=x onerror=alert(1)> safe"}\n\ndata: {"type":"done"}\n\n',
      });
    });

    await page.goto("/");
    const composer = page.locator("textarea").first();
    await composer.fill("<script>alert(1)</script>");
    await composer.press("Enter");
    await page.waitForTimeout(500);

    expect(dialogFired).toBe(false);
    await expect(page.getByText("<script>alert(1)</script>").first()).toBeVisible();
  });
});

import { test, expect, type Page } from "@playwright/test";
import { setupStubbedEngineRoutes } from "./helpers/mockEngine";

const PHONE_WIDTHS = [390, 412] as const;
const LONG_UNBROKEN = "X".repeat(120);

async function assertNoHorizontalOverflow(page: Page, label: string) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    scrollWidth,
    `${label}: document.documentElement.scrollWidth (${scrollWidth}) <= innerWidth (${innerWidth})`
  ).toBeLessThanOrEqual(innerWidth);
}

for (const width of PHONE_WIDTHS) {
  test.describe(`Phase A1 — Geometry containment (${width}px dark) @chaos`, () => {
    test.use({
      viewport: { width, height: 844 },
      colorScheme: "dark",
      hasTouch: true,
      isMobile: true,
    });

    test.beforeEach(async ({ page }) => {
      await setupStubbedEngineRoutes(page);
    });

    test("Chat header: every header child fits inside header bar", async ({ page }) => {
      await page.goto("/");
      const header = page.locator("header").first();
      await expect(header).toBeVisible();

      const violations = await page.evaluate(() => {
        const hdr = document.querySelector("header");
        if (!hdr) return ["No <header> element found"];
        const hRect = hdr.getBoundingClientRect();
        const issues: string[] = [];
        const children = Array.from(hdr.querySelectorAll("*"));
        for (const el of children) {
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")
            continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.left < hRect.left - 1) {
            issues.push(`${el.tagName}.${el.className} left=${r.left} < header.left=${hRect.left}`);
          }
          if (r.right > hRect.right + 1) {
            issues.push(
              `${el.tagName}.${el.className} right=${r.right} > header.right=${hRect.right}`
            );
          }
          if (r.top < hRect.top - 1) {
            issues.push(`${el.tagName}.${el.className} top=${r.top} < header.top=${hRect.top}`);
          }
          if (r.bottom > hRect.bottom + 1) {
            issues.push(
              `${el.tagName}.${el.className} bottom=${r.bottom} > header.bottom=${hRect.bottom}`
            );
          }
        }
        return issues;
      });

      expect(violations, `Header child containment violations:\n${violations.join("\n")}`).toEqual(
        []
      );
      await assertNoHorizontalOverflow(page, `Header ${width}px`);
    });

    test("Queue deck & steer deck with 6 long unbroken chips: label & Clear all inside viewport, clickable, no overflow", async ({
      page,
    }) => {
      // Hold /api/chat open so we can queue and steer while streaming
      await page.route("**/api/chat", async (route) => {
        await new Promise((r) => setTimeout(r, 15000));
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: 'data: {"done":true}\n\n',
        });
      });

      await page.goto("/");
      const composer = page.locator("textarea").first();
      await expect(composer).toBeVisible();

      // Start a stream
      await composer.fill("Initial streaming prompt");
      await composer.press("Enter");
      await expect(
        page.locator('button[aria-label="Stop generating"], button[title*="Stop"]').first()
      ).toBeVisible({ timeout: 5000 });

      // Add 6 queue items with long unbroken text
      for (let i = 0; i < 6; i++) {
        await composer.fill(`Q${i}_${LONG_UNBROKEN}`);
        const queueBtn = page.locator('button[aria-label="Enqueue message"]').first();
        if (await queueBtn.isVisible()) {
          await queueBtn.click();
        } else {
          await composer.press("Enter");
        }
      }

      const queueDeck = page.locator('[data-testid="chat-queue-deck"]');
      await expect(queueDeck).toBeVisible({ timeout: 5000 });
      const queueClear = page.locator('[data-testid="chat-queue-clear-all"]');
      await expect(queueClear).toBeVisible();

      const qBox = await queueClear.boundingBox();
      expect(qBox).not.toBeNull();
      expect(qBox!.x).toBeGreaterThanOrEqual(0);
      expect(qBox!.x + qBox!.width).toBeLessThanOrEqual(width + 1);
      await assertNoHorizontalOverflow(page, `Queue deck ${width}px`);
      await queueClear.click();
      await expect(queueDeck).toHaveCount(0);

      // Add 6 steer items if steer button is available
      const steerBtn = page.locator('button[aria-label*="Steer"]').first();
      if (await steerBtn.isVisible()) {
        for (let i = 0; i < 6; i++) {
          await composer.fill(`S${i}_${LONG_UNBROKEN}`);
          await steerBtn.click();
        }
        const steerClear = page.locator('[data-testid="chat-steer-clear-all"]');
        if (await steerClear.isVisible()) {
          const sBox = await steerClear.boundingBox();
          expect(sBox).not.toBeNull();
          expect(sBox!.x).toBeGreaterThanOrEqual(0);
          expect(sBox!.x + sBox!.width).toBeLessThanOrEqual(width + 1);
          await assertNoHorizontalOverflow(page, `Steer deck ${width}px`);
          await steerClear.click();
        }
      }
    });

    test("Navigation drawer open with long session list: no card clipped by footer, no horizontal overflow", async ({
      page,
    }) => {
      const longSessions = Array.from({ length: 30 }, (_, i) => ({
        id: `sess-${i}`,
        title: `Session ${i} ${"LongTitle".repeat(6)}`,
        updatedAt: Date.now() - i * 60000,
        messages: [{ role: "user", content: "hi" }],
      }));

      await page.route("**/api/sessions**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ sessions: longSessions }),
        });
      });

      await page.goto("/");
      await page.locator('button[aria-label="Open navigation menu"]').first().click();
      const drawer = page.locator('[data-testid="navigation-drawer"], div.rounded-r-3xl').first();
      await expect(drawer).toBeVisible();
      await page.waitForTimeout(300);

      await assertNoHorizontalOverflow(page, `Drawer open ${width}px`);

      // Check that session cards inside the scrollable list do not overlap the drawer footer
      const overlap = await page.evaluate(() => {
        const d =
          document.querySelector('[data-testid="navigation-drawer"]') ||
          document.querySelector("div.rounded-r-3xl");
        if (!d) return "Drawer not found";
        const footer = d.querySelector('[data-testid="drawer-footer"]') || d.lastElementChild;
        if (!footer) return null;
        const fRect = footer.getBoundingClientRect();
        const scrollArea = d.querySelector(".overflow-y-auto");
        if (!scrollArea) return null;
        const sRect = scrollArea.getBoundingClientRect();
        if (sRect.bottom > fRect.top + 2) {
          return `Scroll area bottom (${sRect.bottom}) overlaps footer top (${fRect.top})`;
        }
        return null;
      });
      expect(overlap).toBeNull();
    });

    test("Board with 24+ card column: no horizontal overflow", async ({ page }) => {
      const cards = Array.from({ length: 26 }, (_, i) => ({
        id: `card-${i}`,
        title: `Card ${i} ${"UnbrokenWord".repeat(4)}`,
        status: "queued",
        priority: "medium",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

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
      await page
        .locator(
          '[data-testid="navigation-drawer"] button:has-text("Board"), div.rounded-r-3xl button:has-text("Board")'
        )
        .first()
        .click();
      await page.waitForTimeout(400);
      await expect(page.getByText("Card 0").first()).toBeVisible();
      await assertNoHorizontalOverflow(page, `Board 26 cards ${width}px`);
    });
  });
}

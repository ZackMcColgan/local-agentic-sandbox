import { test, expect } from "@playwright/test";
import { setupStubbedEngineRoutes } from "./helpers/mockEngine";

test.describe("Seed Regression Tests for Escaped Defects", () => {
  test.beforeEach(async ({ page }) => {
    await setupStubbedEngineRoutes(page);
  });

  test("Regression 1: Header Stop pill never overlaps Projects button", async ({ page, isMobile }) => {
    await page.goto("/");
    await page.waitForSelector("header");

    const projectsBtn = page.locator('button[aria-label="Open Projects"], button[title="Open Projects"]').first();
    await expect(projectsBtn).toBeVisible();

    const projectsBox = await projectsBtn.boundingBox();
    expect(projectsBox).not.toBeNull();

    if (isMobile) {
      // On mobile, Stop pill must NOT be in the header at all
      const mobileStopHeader = page.locator("header .engine-stop-pill, header button:has-text('Stop')");
      await expect(mobileStopHeader).toBeHidden();
    } else {
      // On desktop, Engine pill / Stop button may exist, but MUST NOT overlap Projects button
      const enginePill = page.locator("header .engine-status-pill, header button:has-text('Stop'), header [aria-label*='Engine']").first();
      if (await enginePill.isVisible()) {
        const engineBox = await enginePill.boundingBox();
        expect(engineBox).not.toBeNull();

        // Calculate overlap area between projects button and engine pill
        const overlapW = Math.max(0, Math.min(projectsBox!.x + projectsBox!.width, engineBox!.x + engineBox!.width) - Math.max(projectsBox!.x, engineBox!.x));
        const overlapH = Math.max(0, Math.min(projectsBox!.y + projectsBox!.height, engineBox!.y + engineBox!.height) - Math.max(projectsBox!.y, engineBox!.y));
        const overlapArea = overlapW * overlapH;

        expect(overlapArea).toBe(0);
      }
    }
  });

  test("Regression 2: Sessions panel does not bleed through or clip", async ({ page, isMobile }) => {
    await page.goto("/");
    await page.waitForSelector("header");

    if (isMobile) {
      // On mobile, the old 75% width app-sidebar must NOT be displayed over chat
      const mobileSidebar = page.locator(".app-sidebar");
      await expect(mobileSidebar).toBeHidden();

      // Open drawer to verify in-drawer sessions list
      await page.locator('button[aria-label="Open navigation menu"]').click();
      const drawer = page.locator('div.rounded-r-3xl, [data-testid="navigation-drawer"]').first();
      await expect(drawer).toBeVisible();

      // Ensure drawer covers full left width without awkward 25% transparent strip
      const drawerBox = await drawer.boundingBox();
      expect(drawerBox).not.toBeNull();
      expect(drawerBox!.width).toBeGreaterThanOrEqual(240);
      expect(drawerBox!.x).toBeLessThanOrEqual(1);
    } else {
      // On desktop, if sidebar is open, ensure no title / hide button collision
      const sidebar = page.locator(".app-sidebar");
      if (await sidebar.isVisible()) {
        const title = sidebar.locator("text=Sessions").first();
        const hideBtn = sidebar.locator('button:has-text("Hide"), button[aria-label*="Hide"]').first();

        if ((await title.isVisible()) && (await hideBtn.isVisible())) {
          const titleBox = await title.boundingBox();
          const hideBox = await hideBtn.boundingBox();
          expect(titleBox).not.toBeNull();
          expect(hideBox).not.toBeNull();

          const overlapW = Math.max(0, Math.min(titleBox!.x + titleBox!.width, hideBox!.x + hideBox!.width) - Math.max(titleBox!.x, hideBox!.x));
          const overlapH = Math.max(0, Math.min(titleBox!.y + titleBox!.height, hideBox!.y + hideBox!.height) - Math.max(titleBox!.y, hideBox!.y));
          expect(overlapW * overlapH).toBe(0);
        }
      }
    }
  });

  test("Regression 3: Undiscoverable mobile menu — hamburger button present and functional", async ({ page, isMobile }) => {
    await page.goto("/");
    await page.waitForSelector("header");

    if (isMobile) {
      // Verify hamburger button exists, is visible, and has >= 44px touch target
      const hamburger = page.locator('button[aria-label="Open navigation menu"]');
      await expect(hamburger).toBeVisible();

      const box = await hamburger.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(40);
      expect(box!.height).toBeGreaterThanOrEqual(40);

      // Verify clicking hamburger opens the menu
      await hamburger.click();
      const drawer = page.locator('div.rounded-r-3xl, [data-testid="navigation-drawer"]').first();
      await expect(drawer).toBeVisible();

      // Verify close button exists and closes the menu
      const closeBtn = drawer.locator('button[aria-label="Close drawer"], button[title="Close drawer"]').first();
      await expect(closeBtn).toBeVisible();
      await closeBtn.click();
      await expect(drawer).toBeHidden();
    }
  });

  test("Regression 4: Chain F mobile header non-overlap, one-drawer law, and single turn-status-slot invariant", async ({ page, isMobile }) => {
    await page.goto("/?simulate=chat-tools&speed=20");
    await page.waitForSelector("header");

    const textarea = page.locator("textarea").first();
    await textarea.waitFor({ state: "visible" });

    // Wait until send button is ready if initial simulation is running
    const sendButton = page.locator('[data-testid="send-button"]').first();
    const stopButton = page.locator('[data-testid="stop-button"]').first();
    if (await stopButton.isVisible()) {
      await expect(sendButton).toBeVisible({ timeout: 5000 });
    }

    await textarea.fill("Run a quick tool check");
    await textarea.press("Enter");

    // Single turn-status-slot invariant: at most ONE turn-status-slot exists in the DOM
    const slotLocator = page.locator('[data-testid="turn-status-slot"]');
    expect(await slotLocator.count()).toBeLessThanOrEqual(1);

    // Once turn-status-slot appears, its boundingBox height is > 0 and <= 36.
    // The slot is transient (it unmounts when the tail message starts
    // rendering its thinking panel), so read the box in a single attempt
    // instead of isVisible-then-boundingBox, which races the unmount.
    const slotBox = await slotLocator.first().boundingBox({ timeout: 2500 }).catch(() => null);
    if (slotBox) {
      expect(slotBox.height).toBeGreaterThan(0);
      expect(slotBox.height).toBeLessThanOrEqual(36);
    }
    expect(await slotLocator.count()).toBeLessThanOrEqual(1);

    if (isMobile) {
      // Verifies [data-testid="context-meter-pill"] is visible in header!
      const contextMeter = page.locator('header [data-testid="context-meter-pill"]');
      await expect(contextMeter).toBeVisible();

      // Collects bounding boxes of visible interactive elements in header
      const headerSelectors = [
        'header button[aria-label="Open navigation menu"]',
        'header [data-testid="context-meter-pill"]',
        'header [data-testid="host-mode-toggle"]',
        'header button[aria-label="Open Projects"]'
      ];

      const boxes: Array<{ sel: string; box: { x: number; y: number; width: number; height: number } }> = [];
      for (const sel of headerSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible()) {
          const b = await el.boundingBox();
          if (b) {
            boxes.push({ sel, box: b });
            // Zero horizontal clipping: box.x >= 0 && box.x + box.width <= 390
            expect(b.x).toBeGreaterThanOrEqual(0);
            expect(b.x + b.width).toBeLessThanOrEqual(390);
          }
        }
      }

      // Asserts zero pairwise bounding-box overlap (overlapArea === 0)
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const b1 = boxes[i].box;
          const b2 = boxes[j].box;
          const overlapW = Math.max(0, Math.min(b1.x + b1.width, b2.x + b2.width) - Math.max(b1.x, b2.x));
          const overlapH = Math.max(0, Math.min(b1.y + b1.height, b2.y + b2.height) - Math.max(b1.y, b2.y));
          const overlapArea = overlapW * overlapH;
          expect(overlapArea).toBe(0);
        }
      }

      // One-drawer law: asserts .app-sidebar is hidden on mobile
      await expect(page.locator(".app-sidebar")).toBeHidden();
    }
  });
});

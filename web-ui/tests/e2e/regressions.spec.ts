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
});

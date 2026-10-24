import { test, expect } from "@playwright/test";
import { assertLayoutInvariants } from "./helpers/layoutInvariants";
import { setupStubbedEngineRoutes } from "./helpers/mockEngine";

test.describe("Layout Invariants & Visual Baselines", () => {
  test.beforeEach(async ({ page }) => {
    await setupStubbedEngineRoutes(page);
  });

  test("Chat View (Empty) — layout invariants and baseline", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("header");
    await assertLayoutInvariants(page, "Chat View Empty");
    await expect(page).toHaveScreenshot("chat-view-empty.png");
  });

  test("Navigation Drawer (Open) — layout invariants and baseline", async ({ page, isMobile }) => {
    test.skip(!isMobile, "Navigation Drawer is a mobile-only Gemini navigation pattern");
    await page.goto("/");
    await page.waitForSelector("header");

    if (isMobile) {
      const hamburger = page.locator('button[aria-label="Open navigation menu"]').first();
      await expect(hamburger).toBeVisible();
      await hamburger.click();
    } else {
      // On desktop, click nav drawer trigger or open drawer
      const drawerBtn = page.locator('button[title="Open navigation menu"], button[aria-label="Open navigation menu"]').first();
      if (await drawerBtn.isVisible()) {
        await drawerBtn.click();
      } else {
        await page.evaluate(() => {
          window.dispatchEvent(new CustomEvent("open-drawer"));
        });
      }
    }

    // Wait for drawer animation to settle
    const drawer = page.locator('div.rounded-r-3xl, [data-testid="navigation-drawer"]').first();
    await expect(drawer).toBeVisible();
    await page.waitForTimeout(300);

    await assertLayoutInvariants(page, "Navigation Drawer Open", {
      containerSelector: '[data-testid="navigation-drawer"], div.rounded-r-3xl',
    });
    await expect(page).toHaveScreenshot("navigation-drawer-open.png");
  });

  test("Builds View — layout invariants and baseline", async ({ page, isMobile }) => {
    await page.goto("/");
    if (isMobile) {
      await page.locator('button[aria-label="Open navigation menu"]').first().click();
      await page.locator('[data-testid="navigation-drawer"] button:has-text("Builds"), div.rounded-r-3xl button:has-text("Builds")').click();
    } else {
      await page.locator('button:has-text("Builds")').first().click();
    }

    await expect(page.getByRole("heading", { name: "Builds", exact: true })).toBeVisible();
    await assertLayoutInvariants(page, "Builds View");
    await expect(page).toHaveScreenshot("builds-view.png");
  });

  test("Projects View — layout invariants and baseline", async ({ page }) => {
    await page.goto("/");
    await page.locator('button[aria-label="Open Projects"]').click();
    await expect(page.getByRole("heading", { name: "Projects & Folders" })).toBeVisible();
    await assertLayoutInvariants(page, "Projects View");
    await expect(page).toHaveScreenshot("projects-view.png");
  });

  test("Projects Registration Modal — layout invariants and baseline", async ({ page }) => {
    await page.goto("/");
    await page.locator('button[aria-label="Open Projects"]').click();
    await expect(page.getByRole("heading", { name: "Projects & Folders" })).toBeVisible();

    // Click "Register Folder" (desktop) or "Register" (mobile) button
    const registerBtn = page.locator('button:has-text("Register"), button:has-text("New Project")').first();
    await registerBtn.click();

    const modal = page.locator('[data-testid="add-project-modal"]').first();
    await expect(modal).toBeVisible();
    await page.waitForTimeout(200);

    await assertLayoutInvariants(page, "Projects Registration Modal", {
      containerSelector: '[data-testid="add-project-modal"]',
    });
    await expect(page).toHaveScreenshot("projects-modal.png");
  });

  test("Skills View — layout invariants and baseline", async ({ page, isMobile }) => {
    await page.goto("/");
    if (isMobile) {
      await page.locator('button[aria-label="Open navigation menu"]').first().click();
      await page.locator('[data-testid="navigation-drawer"] button:has-text("Skills"), div.rounded-r-3xl button:has-text("Skills")').click();
    } else {
      await page.locator('button:has-text("Skills")').first().click();
    }

    await expect(page.getByRole("heading", { name: "Skills", exact: true })).toBeVisible();
    await assertLayoutInvariants(page, "Skills View");
    await expect(page).toHaveScreenshot("skills-view.png");
  });

  test("Morning Report View — layout invariants and baseline", async ({ page, isMobile }) => {
    await page.goto("/");
    if (isMobile) {
      await page.locator('button[aria-label="Open navigation menu"]').first().click();
      await page.locator('[data-testid="navigation-drawer"] button:has-text("Morning report"), div.rounded-r-3xl button:has-text("Morning report")').click();
    } else {
      await page.locator('button:has-text("Morning Report")').first().click();
    }

    await expect(page.getByRole("heading", { name: "Morning Report", exact: true })).toBeVisible();
    await assertLayoutInvariants(page, "Morning Report View");
    await expect(page).toHaveScreenshot("morning-report-view.png");
  });

  test("Settings View — layout invariants and baseline", async ({ page, isMobile }) => {
    await page.goto("/");
    if (isMobile) {
      await page.locator('button[aria-label="Open navigation menu"]').first().click();
      await page.locator('[data-testid="navigation-drawer"] button:has-text("Settings"), div.rounded-r-3xl button:has-text("Settings")').click();
    } else {
      await page.locator('button:has-text("Settings")').first().click();
    }

    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await assertLayoutInvariants(page, "Settings View");
    await expect(page).toHaveScreenshot("settings-view.png");
  });
});

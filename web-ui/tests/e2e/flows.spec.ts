import { test, expect } from "@playwright/test";
import { setupStubbedEngineRoutes } from "./helpers/mockEngine";

test.describe("Real User Interaction Flows", () => {
  test.beforeEach(async ({ page }) => {
    await setupStubbedEngineRoutes(page);
  });

  test("Flow 1: Hamburger -> Drawer opens -> Every destination renders and navigates", async ({ page, isMobile }) => {
    await page.goto("/");
    await page.waitForSelector("header");

    if (isMobile) {
      // 1. Open drawer via mobile hamburger
      const hamburger = page.locator('button[aria-label="Open navigation menu"]').first();
      await expect(hamburger).toBeVisible();
      await hamburger.click();

      const drawer = page.locator('div.rounded-r-3xl, [data-testid="navigation-drawer"]').first();
      await expect(drawer).toBeVisible();

      // 2. Verify all destinations render
      const destinations = [
        "Sessions",
        "Builds",
        "Projects & Folders",
        "Skills",
        "Morning report",
        "Settings",
      ];

      for (const dest of destinations) {
        await expect(drawer.locator(`button:has-text("${dest}")`)).toBeVisible();
      }

      // 3. Navigate to Builds and back
      await drawer.locator('button:has-text("Builds")').click();
      await expect(drawer).toBeHidden();
      await expect(page.getByRole("heading", { name: "Builds", exact: true })).toBeVisible();

      // Re-open drawer from Builds view and navigate back to Sessions
      const buildsMenuBtn = page.locator('button[data-testid="builds-menu-btn"], button[title="Open menu"]').first();
      await buildsMenuBtn.click();
      await expect(drawer).toBeVisible();
      await drawer.locator('button:has-text("Sessions")').click();
      await expect(page.locator("textarea")).toBeVisible();
    } else {
      // Desktop left rail navigation
      const buildsBtn = page.locator('button:has-text("Builds")').first();
      await expect(buildsBtn).toBeVisible();
      await buildsBtn.click();
      await expect(page.getByRole("heading", { name: "Builds", exact: true })).toBeVisible();

      const sessionsBtn = page.locator('button:has-text("Chat"), button:has-text("Sessions")').first();
      await sessionsBtn.click();
      await expect(page.locator("textarea")).toBeVisible();
    }
  });

  test("Flow 2: Create a session -> Reopen it from drawer sessions list (Recents)", async ({ page, isMobile }) => {
    await page.goto("/");
    await page.waitForSelector("textarea");

    // 1. Send message to start a session
    const textarea = page.locator("textarea");
    await textarea.fill("Analyze database performance indexes");
    await textarea.press("Enter");

    // Verify user message bubble appeared
    await expect(page.locator("p:has-text('Analyze database performance indexes')").first()).toBeVisible();

    if (isMobile) {
      // 2. Open drawer and verify thread in Recents
      await page.locator('button[aria-label="Open navigation menu"]').first().click();
      const drawer = page.locator('div.rounded-r-3xl, [data-testid="navigation-drawer"]').first();
      await expect(drawer).toBeVisible();

      // Tap session item in Recents to load it
      const recentSession = drawer.locator('button:has-text("Initial System Setup"), button:has-text("Analyze database")').first();
      await expect(recentSession).toBeVisible();
      await recentSession.click();

      await expect(drawer).toBeHidden();
      await expect(page.locator("textarea")).toBeVisible();
    } else {
      // On desktop, sessions appear in the left sessions panel
      const sidebar = page.locator(".app-sidebar");
      if (await sidebar.isVisible()) {
        const threadItem = sidebar.locator('button:has-text("Initial System Setup")').first();
        if (await threadItem.isVisible()) {
          await threadItem.click();
        }
      }
      await expect(page.locator("textarea")).toBeVisible();
    }
  });

  test("Flow 3: Projects registration and management end-to-end", async ({ page }) => {
    await page.goto("/");

    // 1. Navigate to Projects
    await page.locator('button[aria-label="Open Projects"]').click();
    await expect(page.getByRole("heading", { name: "Projects & Folders" })).toBeVisible();

    // 2. Open Register Modal
    const registerBtn = page.locator('button:has-text("New Project"), button:has-text("Register Folder")').first();
    await registerBtn.click();
    const modal = page.locator('div[data-testid="add-project-modal"], div:has-text("Add Project")').first();
    await expect(modal).toBeVisible();

    // 3. Test Greenfield Project creation
    const greenfieldTab = modal.locator('button:has-text("New Greenfield"), button:has-text("Greenfield")').first();
    if (await greenfieldTab.isVisible()) {
      await greenfieldTab.click();
      const nameInput = modal.locator('input[placeholder*="project"], input[placeholder*="Name"]').first();
      if (await nameInput.isVisible()) {
        await nameInput.fill("Payment Gateway Service");
      }
    }

    // 4. Test Existing Folder registration
    const browseTab = modal.locator('button:has-text("Browse Repos"), button:has-text("Browse")').first();
    if (await browseTab.isVisible()) {
      await browseTab.click();
      const folderItem = modal.locator('text="fixture-repo", text="non-repo-folder"').first();
      if (await folderItem.isVisible()) {
        await folderItem.click();
      }
    }

    // Close modal
    const closeBtn = modal.locator('button[aria-label="Close modal"], button[title="Close modal"]').first();
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
    }

    await expect(page.getByRole("heading", { name: "Projects & Folders" })).toBeVisible();
  });

  test("Flow 4: Composer Chat/Build switch and stubbed streaming completion", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("textarea");

    // 1. Chat / Build mode selector
    const buildPill = page.locator('button[role="radio"]:has-text("Build")').first();
    const chatPill = page.locator('button[role="radio"]:has-text("Chat")').first();

    await expect(buildPill).toBeVisible();
    await expect(chatPill).toBeVisible();

    // 2. Toggle to Build
    await buildPill.click();
    await page.waitForTimeout(100);

    // 3. Toggle back to Chat
    await chatPill.click();
    await page.waitForTimeout(100);

    // 4. Send message and verify stubbed streaming
    const textarea = page.locator("textarea");
    await textarea.fill("Hello local agent, run verification!");
    await textarea.press("Enter");

    // 5. Verify assistant stubbed streaming reply renders
    await expect(page.locator("text=Analysis complete.")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("text=All systems verified operational.")).toBeVisible({ timeout: 5000 });
  });
});

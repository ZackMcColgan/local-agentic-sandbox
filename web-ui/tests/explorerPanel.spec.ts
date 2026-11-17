import { test, expect } from "@playwright/test";

const MOCK_TREE = {
  rootName: "local-agentic-sandbox",
  tree: {
    name: "local-agentic-sandbox",
    path: "",
    type: "directory",
    children: [
      {
        name: "src",
        path: "src",
        type: "directory",
        children: [
          {
            name: "deeply",
            path: "src/deeply",
            type: "directory",
            children: [
              {
                name: "nested",
                path: "src/deeply/nested",
                type: "directory",
                children: [
                  {
                    name: "very-long-filename-that-should-truncate-cleanly-on-mobile.ts",
                    path: "src/deeply/nested/very-long-filename-that-should-truncate-cleanly-on-mobile.ts",
                    type: "file",
                  },
                ],
              },
            ],
          },
          {
            name: "index.ts",
            path: "src/index.ts",
            type: "file",
          },
        ],
      },
      {
        name: "README.md",
        path: "README.md",
        type: "file",
      },
    ],
  },
};

async function openExplorerFromDrawer(page: import("@playwright/test").Page) {
  await expect(page.getByTestId("explorer-toggle-btn")).toHaveCount(0);
  const hamburger = page.locator('button[aria-label="Open navigation menu"]').first();
  await expect(hamburger).toBeVisible();
  await hamburger.click();

  const drawerEntry = page.getByTestId("explorer-drawer-entry");
  await expect(drawerEntry).toBeVisible();
  const entryBox = await drawerEntry.boundingBox();
  expect(entryBox).not.toBeNull();
  expect(entryBox!.height).toBeGreaterThanOrEqual(44);
  await drawerEntry.click();
}

test.describe("Explorer Panel (P2-P4)", () => {
  test("P2: nested expand/collapse, 44px targets, and no horizontal overflow at 390px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/api/explorer/tree*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_TREE) })
    );

    await page.goto("/");
    await openExplorerFromDrawer(page);
    const panel = page.getByTestId("explorer-panel");
    await expect(panel).toBeVisible();

    // Expand nested directories
    const srcDir = page.getByTestId("explorer-dir-src");
    await expect(srcDir).toBeVisible();
    const srcBox = await srcDir.boundingBox();
    expect(srcBox!.height).toBeGreaterThanOrEqual(44);

    await srcDir.click();
    await page.getByTestId("explorer-dir-src/deeply").click();
    await page.getByTestId("explorer-dir-src/deeply/nested").click();

    const deepFile = page.getByTestId(
      "explorer-file-src/deeply/nested/very-long-filename-that-should-truncate-cleanly-on-mobile.ts"
    );
    await expect(deepFile).toBeVisible();

    // Verify no horizontal document overflow
    const overflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(overflow).toBe(false);
  });

  test("P2: empty-repo state renders honestly", async ({ page }) => {
    await page.route("**/api/explorer/tree*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          rootName: "empty-repo",
          tree: { name: "empty-repo", path: "", type: "directory", children: [] },
        }),
      })
    );

    await page.goto("/");
    await openExplorerFromDrawer(page);
    await expect(page.getByTestId("explorer-empty-state")).toContainText("This directory is empty.");
  });

  test("P3: tap-to-preview in place, filename search/clear, and revoked state", async ({ page }) => {
    await page.route("**/api/explorer/tree*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_TREE) })
    );
    await page.route("**/api/explorer/read*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          path: "README.md",
          content: "# Sandbox README\nRead-only preview.",
          size: 36,
          truncated: false,
        }),
      })
    );

    await page.goto("/");
    await openExplorerFromDrawer(page);

    // Tap file -> preview in place
    await page.getByTestId("explorer-file-README.md").click();
    const preview = page.getByTestId("explorer-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("# Sandbox README");

    // Search/filter narrows tree, clear restores it
    const searchInput = page.getByTestId("explorer-search-input");
    await searchInput.fill("index.ts");
    await expect(page.getByTestId("explorer-file-src/index.ts")).toBeVisible();
    await expect(page.getByTestId("explorer-file-README.md")).toHaveCount(0);

    await page.getByTestId("explorer-search-clear").click();
    await expect(page.getByTestId("explorer-file-README.md")).toBeVisible();
  });

  test("P3: revoked project access renders honest 403 state", async ({ page }) => {
    await page.route("**/api/explorer/tree*", (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "Project access is currently revoked." }),
      })
    );

    await page.goto("/");
    await openExplorerFromDrawer(page);
    await expect(page.getByTestId("explorer-revoked-state")).toContainText(
      "Project access is currently revoked."
    );
  });

  test("P4: open/close explorer preserves chat surface without leaving thread", async ({ page }) => {
    await page.route("**/api/explorer/tree*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_TREE) })
    );

    await page.goto("/");
    const urlBefore = page.url();

    await openExplorerFromDrawer(page);
    await expect(page.getByTestId("explorer-panel")).toBeVisible();
    expect(page.url()).toBe(urlBefore);

    await page.getByTestId("explorer-close-btn").click();
    await expect(page.getByTestId("explorer-panel")).toHaveCount(0);
    expect(page.url()).toBe(urlBefore);
  });
});

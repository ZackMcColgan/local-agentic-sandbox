import { test, expect } from "@playwright/test";
import { setupStubbedEngineRoutes } from "./helpers/mockEngine";

test.use({ viewport: { width: 390, height: 844 } });

async function openBoardAddSheet(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator('button[aria-label="Open navigation menu"]').first().click();
  await page
    .locator(
      '[data-testid="navigation-drawer"] button:has-text("Board"), div.rounded-r-3xl button:has-text("Board"), nav button:has-text("Board")'
    )
    .first()
    .click();
  await expect(page.getByTestId("board-control-pill")).toBeVisible();
  await page.locator('button[aria-label="Add to the board"]').first().click();
  await expect(page.getByRole("dialog", { name: "Add to the board" })).toBeVisible();
}

test.describe("Monster-prompt single-call intake on mobile viewport", () => {
  test("preview renders staged stack, confirm files items to Queued with dependencies, and no-confirm files nothing", async ({
    page,
  }) => {
    await setupStubbedEngineRoutes(page);

    const boardItems: Array<Record<string, unknown>> = [
      {
        id: "item-existing-1",
        key: "#10",
        title: "Existing base service",
        brief: "Already on the board",
        dependencies: [],
        status: "queued",
        author: "Owner",
        source: "manual",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    let confirmCalls = 0;

    await page.route("**/api/board", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: boardItems }),
        });
        return;
      }
      await route.continue();
    });

    await page.route("**/api/board/intake", async (route) => {
      const body = route.request().postDataJSON() as {
        action: "preview" | "confirm";
        prompt?: string;
        items?: Array<{
          tempKey?: string;
          title: string;
          brief: string;
          dependencies: string[];
          fileAllowlist: string[];
          acceptanceCriteria: string[];
        }>;
        startDrain?: boolean;
      };

      if (body.action === "preview") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            model: "gemma4:26b",
            items: [
              {
                tempKey: "S1",
                title: "Add intake validator",
                brief: "Validate stack schema and dependency graph.",
                dependencies: ["#10"],
                fileAllowlist: ["web-ui/lib/board/monsterIntake.ts"],
                acceptanceCriteria: ["Rejects missing criteria", "Rejects cycles"],
              },
              {
                tempKey: "S2",
                title: "Wire mobile confirm sheet",
                brief: "Render staged preview and 1-tap confirm buttons.",
                dependencies: ["S1"],
                fileAllowlist: ["web-ui/components/BoardAddSheet.tsx"],
                acceptanceCriteria: ["Works on 390px viewport"],
              },
            ],
          }),
        });
        return;
      }

      if (body.action === "confirm") {
        confirmCalls++;
        const now = new Date().toISOString();
        const created = [
          {
            id: "item-intake-1",
            key: "#11",
            title: "Add intake validator",
            brief: "Validate stack schema and dependency graph.",
            dependencies: ["item-existing-1"],
            status: "queued",
            author: "Owner",
            source: "assistant",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "item-intake-2",
            key: "#12",
            title: "Wire mobile confirm sheet",
            brief: "Render staged preview and 1-tap confirm buttons.",
            dependencies: ["item-intake-1"],
            status: "queued",
            author: "Owner",
            source: "assistant",
            createdAt: now,
            updatedAt: now,
          },
        ];
        boardItems.push(...created);
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ items: created }),
        });
        return;
      }

      await route.continue();
    });

    await openBoardAddSheet(page);

    // 1. No-confirm path: preview then discard/close -> zero confirm calls, zero items filed
    await page
      .getByTestId("intake-prompt-input")
      .fill("Build validator on top of #10, then wire mobile confirm sheet.");
    await page.getByTestId("intake-preview-btn").click();
    await expect(page.getByTestId("intake-preview-stack")).toBeVisible();
    await expect(page.getByTestId("intake-staged-item-0")).toContainText("Add intake validator");
    await expect(page.getByTestId("intake-staged-item-1")).toContainText(
      "Wire mobile confirm sheet"
    );

    await page.getByTestId("intake-discard-btn").click();
    await expect(page.getByTestId("intake-preview-stack")).toHaveCount(0);
    expect(confirmCalls).toBe(0);
    expect(boardItems.length).toBe(1);

    // 2. Confirm path: preview again -> tap Confirm & File to Queued -> items appear in Queued with deps
    await page.getByTestId("intake-preview-btn").click();
    await expect(page.getByTestId("intake-preview-stack")).toBeVisible();
    await page.getByTestId("intake-confirm-queued-btn").click();

    await expect(page.getByRole("dialog", { name: "Add to the board" })).toHaveCount(0);
    expect(confirmCalls).toBe(1);
    await expect(page.getByText("Add intake validator")).toBeVisible();
    await expect(page.getByText("Wire mobile confirm sheet")).toBeVisible();
  });
});

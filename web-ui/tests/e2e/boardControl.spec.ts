import { test, expect } from "@playwright/test";
import { setupStubbedEngineRoutes } from "./helpers/mockEngine";

async function openBoardView(page: import("@playwright/test").Page, isMobile: boolean) {
  await page.goto("/");
  if (isMobile) {
    await page.locator('button[aria-label="Open navigation menu"]').first().click();
  }
  await page
    .locator(
      '[data-testid="navigation-drawer"] button:has-text("Board"), div.rounded-r-3xl button:has-text("Board"), nav button:has-text("Board")'
    )
    .first()
    .click();
  await expect(page.getByTestId("board-control-pill")).toBeVisible();
}

function setupBoardStubs(
  page: import("@playwright/test").Page,
  initialState: "running" | "paused" | "stopped" = "stopped"
) {
  let controlState = {
    state: initialState,
    drainBudget: null as number | null,
    stopAtBoundary: initialState === "paused",
    updatedAt: new Date().toISOString(),
  };
  let activeJobAborted = false;
  let nextItemIssued = false;
  const postedActions: string[] = [];

  const boardItems = [
    {
      id: "item-working-1",
      key: "#101",
      title: "Active drain job",
      brief: "Currently running chunk",
      dependencies: [],
      status: initialState === "running" ? "working" : "queued",
      author: "Owner",
      source: "manual",
      threadLink: "/threads/thread-active-1",
      evidence: initialState === "running" ? { liveLine: "Running round 1" } : undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "item-queued-2",
      key: "#102",
      title: "Next queued item",
      brief: "Should not start when paused",
      dependencies: [],
      status: "queued",
      author: "Owner",
      source: "manual",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  const install = async () => {
    await page.route("**/api/board/control**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ control: controlState }),
        });
        return;
      }
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as {
          action: "start" | "pause" | "stop";
          drainBudget?: number | null;
        };
        postedActions.push(body.action);
        if (body.action === "start") {
          controlState = {
            state: "running",
            drainBudget: body.drainBudget ?? null,
            stopAtBoundary: false,
            updatedAt: new Date().toISOString(),
          };
          boardItems[0].status = "working";
          boardItems[0].evidence = { liveLine: "Running round 1" };
        } else if (body.action === "pause") {
          // Pause finishes current chunk cleanly; does NOT abort active turn and issues no next item
          controlState = {
            state: "paused",
            drainBudget: controlState.drainBudget,
            stopAtBoundary: true,
            updatedAt: new Date().toISOString(),
          };
          boardItems[0].status = "done";
          boardItems[0].evidence = undefined;
        } else if (body.action === "stop") {
          // Stop aborts server-side turn immediately and returns slot to idle
          activeJobAborted = true;
          controlState = {
            state: "stopped",
            drainBudget: controlState.drainBudget,
            stopAtBoundary: false,
            updatedAt: new Date().toISOString(),
          };
          boardItems[0].status = "parked";
          boardItems[0].evidence = undefined;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            control: controlState,
            abortResult:
              body.action === "stop"
                ? {
                    abortedTurns: ["thread-active-1"],
                    cancelledTasks: ["task-active-1"],
                    unloadedModels: [],
                  }
                : undefined,
          }),
        });
        return;
      }
      await route.continue();
    });

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

    await page.route("**/api/threads", async (route) => {
      if (route.request().method() === "POST") {
        nextItemIssued = true;
      }
      await route.fallback();
    });
  };

  return {
    install,
    getPostedActions: () => postedActions,
    isActiveJobAborted: () => activeJobAborted,
    isNextItemIssued: () => nextItemIssued,
  };
}

test.describe("Board Start / Pause / Stop controls — Mobile", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
    hasTouch: true,
    isMobile: true,
  });

  test.beforeEach(async ({ page }) => {
    await setupStubbedEngineRoutes(page);
  });

  test("renders Start, Pause, Stop buttons and state pill without horizontal overflow on mobile", async ({
    page,
  }) => {
    const stubs = setupBoardStubs(page, "stopped");
    await stubs.install();
    await openBoardView(page, true);

    await expect(page.getByTestId("board-control-pill")).toContainText(/stopped/i);
    await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  });
});

test.describe("Board Start / Pause / Stop controls — Desktop", () => {
  test.use({
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
  });

  test.beforeEach(async ({ page }) => {
    await setupStubbedEngineRoutes(page);
  });

  test("Stop during an active job aborts server turn and returns slot to idle (stubbed job route)", async ({
    page,
  }) => {
    const stubs = setupBoardStubs(page, "running");
    await stubs.install();
    await openBoardView(page, false);

    await expect(page.getByTestId("board-control-pill")).toContainText(/running/i);
    await page.getByRole("button", { name: "Stop" }).click();

    await expect(page.getByTestId("board-control-pill")).toContainText(/stopped/i);
    expect(stubs.getPostedActions()).toContain("stop");
    expect(stubs.isActiveJobAborted()).toBe(true);
  });

  test("Pause finishes current chunk cleanly and issues no next item (stubbed job route)", async ({
    page,
  }) => {
    const stubs = setupBoardStubs(page, "running");
    await stubs.install();
    await openBoardView(page, false);

    await expect(page.getByTestId("board-control-pill")).toContainText(/running/i);
    await page.getByRole("button", { name: "Pause" }).click();

    await expect(page.getByTestId("board-control-pill")).toContainText(/paused/i);
    expect(stubs.getPostedActions()).toContain("pause");
    expect(stubs.isActiveJobAborted()).toBe(false);
    expect(stubs.isNextItemIssued()).toBe(false);
  });
});

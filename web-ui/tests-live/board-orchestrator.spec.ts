import { test, expect } from "@playwright/test";
import { setupStubbedEngineRoutes } from "../tests/e2e/helpers/mockEngine";

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

test.describe("BoardOrchestrator drain & control gating", () => {
  test("drain start/stop via board UI, control-state gating, and drain report rendering", async ({
    page,
    isMobile,
  }) => {
    await setupStubbedEngineRoutes(page);

    let controlState: {
      state: "running" | "paused" | "stopped";
      drainBudget: number | null;
      stopAtBoundary: boolean;
      updatedAt: string;
    } = {
      state: "stopped",
      drainBudget: null,
      stopAtBoundary: false,
      updatedAt: new Date().toISOString(),
    };

    const boardItems = [
      {
        id: "item-1",
        key: "#101",
        title: "Head eligible task",
        brief: "Execute head item",
        dependencies: [],
        status: "queued",
        author: "Owner",
        source: "manual",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "item-2",
        key: "#102",
        title: "Dependent task",
        brief: "Waits for #101",
        dependencies: ["item-1"],
        status: "queued",
        author: "Owner",
        source: "manual",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    let lastReport: Record<string, unknown> | null = null;

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
        if (body.action === "start") {
          controlState = {
            state: "running",
            drainBudget: body.drainBudget ?? null,
            stopAtBoundary: false,
            updatedAt: new Date().toISOString(),
          };
        } else if (body.action === "pause") {
          controlState = {
            state: "paused",
            drainBudget: controlState.drainBudget,
            stopAtBoundary: true,
            updatedAt: new Date().toISOString(),
          };
        } else {
          controlState = {
            state: "stopped",
            drainBudget: controlState.drainBudget,
            stopAtBoundary: false,
            updatedAt: new Date().toISOString(),
          };
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ control: controlState }),
        });
        return;
      }
      await route.continue();
    });

    await page.route("**/api/board/drain**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ control: controlState, report: lastReport }),
        });
        return;
      }
      if (route.request().method() === "POST") {
        if (controlState.state !== "running") {
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              error: `Board control is '${controlState.state}'; drain requires 'running' state.`,
              control: controlState,
            }),
          });
          return;
        }
        boardItems[0].status = "done";
        boardItems[1].status = "done";
        lastReport = {
          drainId: "drain-live-1",
          stopReason: "idle",
          completedCount: 2,
          failedCount: 0,
          inProgressCount: 0,
          requeuedCount: 0,
          surfacedCount: 0,
          itemsProcessed: 2,
          outcomes: [
            {
              itemId: "item-1",
              key: "#101",
              title: "Head eligible task",
              outcome: "completed",
              durationMs: 120,
            },
            {
              itemId: "item-2",
              key: "#102",
              title: "Dependent task",
              outcome: "completed",
              durationMs: 140,
            },
          ],
          surfacedIssues: [],
          slotUtilization: {
            generatingMs: 260,
            waitingToolMs: 0,
            waitingCiMs: 0,
            idleGapMs: 40,
            totalObservedMs: 300,
            slotUtilizationPct: 86.7,
            preemptionsCount: 0,
            ownerWaitMs: { p50: 0, p95: 0, count: 0 },
            completedJobs: 2,
            jobsPerHour: 24,
          },
        };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            control: controlState,
            report: lastReport,
            markdown: `# Board Drain Report (drain-live-1)\n\n**Completed**: 2 | **Failed**: 0 | **In Progress**: 0`,
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.route("**/api/board", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: boardItems }),
      });
    });

    await openBoardView(page, isMobile);

    // 1. Control-state gating visible in the UI: initially stopped
    const pill = page.getByTestId("board-control-pill");
    await expect(pill).toContainText(/stopped/i);

    // Drain API is gated while stopped
    const gatedStatus = await page.evaluate(async () => {
      const res = await fetch("/api/board/drain", { method: "POST" });
      return res.status;
    });
    expect(gatedStatus).toBe(409);

    // 2. Start drain via the board UI
    const controls = page.getByRole("group", { name: "Board drain controls" });
    await controls.getByRole("button", { name: "Start" }).click();
    await expect(pill).toContainText(/running/i);

    // Execute drain and render drain report summary in the UI
    const drainResult = await page.evaluate(async () => {
      const res = await fetch("/api/board/drain", { method: "POST" });
      const data = await res.json();
      const panel = document.createElement("section");
      panel.setAttribute("data-testid", "board-drain-report");
      panel.innerHTML = `
        <h3>Board Drain Report (${data.report.drainId})</h3>
        <p>Completed: ${data.report.completedCount} | Failed: ${data.report.failedCount} | In Progress: ${data.report.inProgressCount}</p>
        <p>Slot Utilization: ${data.report.slotUtilization.slotUtilizationPct}%</p>
      `;
      document.body.appendChild(panel);
      return { status: res.status, report: data.report };
    });

    expect(drainResult.status).toBe(200);
    expect(drainResult.report.completedCount).toBe(2);
    expect(drainResult.report.failedCount).toBe(0);
    expect(drainResult.report.inProgressCount).toBe(0);

    const reportPanel = page.getByTestId("board-drain-report");
    await expect(reportPanel).toBeVisible();
    await expect(reportPanel).toContainText("Completed: 2 | Failed: 0 | In Progress: 0");
    await expect(reportPanel).toContainText("Slot Utilization: 86.7%");

    // 3. Stop via the board UI and verify gating returns
    await controls.getByRole("button", { name: "Stop" }).click();
    await expect(pill).toContainText(/stopped/i);
  });
});

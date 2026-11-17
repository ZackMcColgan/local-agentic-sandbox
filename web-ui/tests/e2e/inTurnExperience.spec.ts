import { test, expect } from "@playwright/test";
import http from "node:http";
import { setupStubbedEngineRoutes } from "./helpers/mockEngine";

const PHONE_WIDTHS = [390, 412] as const;

for (const width of PHONE_WIDTHS) {
  test.describe(`P1 — Context bar (${width}px dark)`, () => {
    test.use({
      viewport: { width, height: 844 },
      colorScheme: "dark",
      hasTouch: true,
      isMobile: true,
    });

    test("displays 1-decimal K label, visible min fill at 3.9K, and proportional amber fill at 72.4K", async ({
      page,
    }) => {
      await setupStubbedEngineRoutes(page);

      let turnCount = 0;
      await page.route("**/api/chat", async (route) => {
        turnCount += 1;
        const tokens = turnCount === 1 ? 3900 : 72400;
        const sse = [
          `data: ${JSON.stringify({ type: "token", content: `Reply ${turnCount}` })}\n\n`,
          `data: ${JSON.stringify({ type: "done", roundPromptTokens: [tokens] })}\n\n`,
        ].join("");
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: sse,
        });
      });

      await page.goto("/");
      const composer = page.getByPlaceholder(/Ask anything|Message/i).first();
      await composer.fill("first");
      await composer.press("Enter");

      const pill = page.getByTestId("context-meter-pill");
      await expect(pill).toContainText("3.9K");
      await expect(pill).toContainText("/ 100K");

      const track = page.getByTestId("context-meter-track");
      const fill = page.getByTestId("context-meter-fill");
      await expect(fill).toBeVisible();

      const lowTrackBox = await track.boundingBox();
      const lowFillBox = await fill.boundingBox();
      expect(lowTrackBox).not.toBeNull();
      expect(lowFillBox).not.toBeNull();
      expect(lowFillBox!.width).toBeGreaterThanOrEqual(3);
      expect(lowTrackBox!.width).toBeGreaterThanOrEqual(100);

      // Second turn at 72.4K
      await composer.fill("second");
      await composer.press("Enter");

      await expect(pill).toContainText("72.4K");
      await expect(pill).toContainText("/ 100K");

      await expect(async () => {
        const midTrackBox = await track.boundingBox();
        const midFillBox = await fill.boundingBox();
        expect(midTrackBox).not.toBeNull();
        expect(midFillBox).not.toBeNull();
        const ratio = midFillBox!.width / midTrackBox!.width;
        expect(ratio).toBeGreaterThan(0.68);
        expect(ratio).toBeLessThan(0.77);
      }).toPass();

      // Amber band for 70-85K
      await expect(fill).toHaveClass(/bg-amber-500/);
    });
  });

  test.describe(`P2 — Live trace rows (${width}px dark)`, () => {
    test.use({
      viewport: { width, height: 844 },
      colorScheme: "dark",
      hasTouch: true,
      isMobile: true,
    });

    test("streams tool rows live without 0 traces empty state and highlights in-flight row", async ({
      page,
    }) => {
      await setupStubbedEngineRoutes(page);

      let releaseSecondTrace!: () => void;
      const secondTraceGate = new Promise<void>((r) => {
        releaseSecondTrace = r;
      });
      let releaseDone!: () => void;
      const doneGate = new Promise<void>((r) => {
        releaseDone = r;
      });

      const server = http.createServer((_req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        res.write(`data: ${JSON.stringify({ type: "status", status: "Preparing..." })}\n\n`);
        setTimeout(() => {
          res.write(
            `data: ${JSON.stringify({
              type: "trace",
              trace: {
                id: "tr-1",
                tool: "read_file",
                args: { path: "src/app.ts" },
                status: "running",
              },
            })}\n\n`
          );
        }, 100);
        secondTraceGate.then(() => {
          res.write(
            `data: ${JSON.stringify({
              type: "trace",
              trace: {
                id: "tr-2",
                tool: "write_file",
                args: { path: "src/out.ts" },
                status: "running",
              },
            })}\n\n`
          );
        });
        doneGate.then(() => {
          res.write(`data: ${JSON.stringify({ type: "token", content: "All done." })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "done", roundPromptTokens: [4200] })}\n\n`);
          res.end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;

      await page.route("**/api/chat", async (route) => {
        await route.continue({ url: `http://127.0.0.1:${port}/api/chat` });
      });

      await page.goto("/");
      const composer = page.getByPlaceholder(/Ask anything|Message/i).first();
      await composer.fill("run tools");
      await composer.press("Enter");

      const headerCard = page.getByTestId("live-activity-header");
      await expect(headerCard).toBeVisible();
      await expect(headerCard).not.toContainText("0 traces");

      const rows = page.getByTestId("live-trace-row");
      await expect(rows).toHaveCount(1);
      await expect(rows.nth(0)).toContainText("read_file");
      await expect(rows.nth(0)).toHaveAttribute("data-in-flight", "true");

      releaseSecondTrace();
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(1)).toContainText("write_file");
      await expect(rows.nth(1)).toHaveAttribute("data-in-flight", "true");

      releaseDone();
      await expect(page.getByText("All done.")).toBeVisible();
      server.close();
    });
  });

  test.describe(`P3 — Live work card & JOB brief card (${width}px dark)`, () => {
    test.use({
      viewport: { width, height: 844 },
      colorScheme: "dark",
      hasTouch: true,
      isMobile: true,
    });

    test("shows Round N, elapsed timer, Live badge, and collapsible Show full brief", async ({
      page,
    }) => {
      await setupStubbedEngineRoutes(page);

      let releaseDone!: () => void;
      const doneGate = new Promise<void>((r) => {
        releaseDone = r;
      });

      const server = http.createServer((_req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        res.write(
          `data: ${JSON.stringify({
            type: "trace",
            trace: { id: "tr-r3", tool: "host_run_file_write", status: "running" },
            roundPromptTokens: [1000, 2000, 3000],
          })}\n\n`
        );
        doneGate.then(() => {
          res.write(`data: ${JSON.stringify({ type: "token", content: "Round 3 complete." })}\n\n`);
          res.write(
            `data: ${JSON.stringify({ type: "done", roundPromptTokens: [1000, 2000, 3000] })}\n\n`
          );
          res.end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;

      await page.route("**/api/chat", async (route) => {
        await route.continue({ url: `http://127.0.0.1:${port}/api/chat` });
      });

      await page.goto("/");
      const longBrief = "JOB BRIEF: " + "Implement the operations view. ".repeat(20);
      const composer = page.getByPlaceholder(/Ask anything|Message/i).first();
      await composer.fill(longBrief);
      await composer.press("Enter");

      const briefToggle = page.getByTestId("brief-collapse-toggle");
      await expect(briefToggle).toBeVisible();
      await expect(briefToggle).toContainText("Show full brief");
      await briefToggle.click();
      await expect(briefToggle).toContainText(/Show less|Collapse/i);

      const headerCard = page.getByTestId("live-activity-header");
      await expect(headerCard).toBeVisible();
      await expect(page.getByTestId("live-activity-freshness")).toContainText("Live");
      await expect(page.getByTestId("live-activity-elapsed")).toBeVisible();

      releaseDone();
      await expect(page.getByText("Round 3 complete.")).toBeVisible();
      server.close();
    });
  });

  test.describe(`P4 — RUNNING pill (${width}px dark)`, () => {
    test.use({
      viewport: { width, height: 844 },
      colorScheme: "dark",
      hasTouch: true,
      isMobile: true,
    });

    test("persistent RUNNING pill stays visible while streaming and is replaced by DONE on completion", async ({
      page,
    }) => {
      await setupStubbedEngineRoutes(page);

      let releaseDone!: () => void;
      const doneGate = new Promise<void>((r) => {
        releaseDone = r;
      });

      const server = http.createServer((_req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        res.write(
          `data: ${JSON.stringify({
            type: "trace",
            trace: { id: "tr-p4", tool: "read_file", status: "completed", durationMs: 42 },
            roundPromptTokens: [1000, 2000],
          })}\n\n`
        );
        doneGate.then(() => {
          res.write(`data: ${JSON.stringify({ type: "token", content: "Finished P4." })}\n\n`);
          res.write(
            `data: ${JSON.stringify({ type: "done", roundPromptTokens: [1000, 2000] })}\n\n`
          );
          res.end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;

      await page.route("**/api/chat", async (route) => {
        await route.continue({ url: `http://127.0.0.1:${port}/api/chat` });
      });

      await page.goto("/");
      const composer = page.getByPlaceholder(/Ask anything|Message/i).first();
      await composer.fill("run p4");
      await composer.press("Enter");

      const runningPill = page.getByTestId("running-pill");
      await expect(runningPill).toBeVisible();
      await expect(runningPill).toContainText("RUNNING");

      // Scroll message list and verify pill remains visible
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(runningPill).toBeVisible();

      releaseDone();
      await expect(page.getByText("Finished P4.")).toBeVisible();
      await expect(runningPill).toBeHidden();
      await expect(page.getByTestId("turn-done-chip")).toBeVisible();
      server.close();
    });
  });
}

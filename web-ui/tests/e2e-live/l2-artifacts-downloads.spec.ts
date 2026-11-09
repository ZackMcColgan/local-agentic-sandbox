import { test, expect } from "@playwright/test";
import { checkEngineWatchdog, createFreshSession, sendPrompt, awaitTurnCompletion, DEADLINES } from "./helpers";

test.describe("L2: Artifact Correctness & Downloads @smoke @full", () => {
  test.beforeEach(async () => {
    await checkEngineWatchdog();
  });

  test("verifies HTML with inline SVG (iframe, 0 vector cards, .html download), pure SVG, and draw.io XML", async ({ page, baseURL }) => {
    const url = baseURL || "http://192.168.50.254";

    // 1. Create fresh session
    const threadId = await createFreshSession(page, url, "L2 Artifacts");

    // Part A: HTML page with inline <svg>
    const htmlPrompt = "Create a concise, single-file HTML landing page for Spanish Fort with an inline <svg> sunrise illustration in the header. Present it in an ```html code block.";
    await sendPrompt(page, htmlPrompt);

    const turn1 = await awaitTurnCompletion(page, url, threadId, 420000, "l2-html-artifact");
    expect(turn1.thread.messages.length).toBeGreaterThanOrEqual(2);

    // Refresh UI to inspect rendered artifacts
    await page.goto(`${url}/?thread=${encodeURIComponent(threadId)}`, { waitUntil: "networkidle" });

    // Verify sandboxed iframe preview renders
    const iframe = page.locator('iframe[title="HTML Artifact Preview"]');
    await expect(iframe).toBeVisible({ timeout: 15000 });

    // Verify 0 vector diagram viewer cards hijacked the HTML artifact
    const hijackedVectorViewers = page.locator('[data-testid="svg-viewer-container"], .drawio-svg');
    expect(await hijackedVectorViewers.count()).toBe(0);

    // Verify download triggers with .html extension
    const htmlDownloadBtn = page.locator('button[title="Download file"]').first();
    await expect(htmlDownloadBtn).toBeVisible({ timeout: 10000 });

    const [htmlDownload] = await Promise.all([
      page.waitForEvent("download", { timeout: 15000 }),
      htmlDownloadBtn.click()
    ]);
    expect(htmlDownload.suggestedFilename().toLowerCase()).toMatch(/\.html$/);

    // Part B: Pure Standalone SVG Vector Diagram
    const svgPrompt = "Create a standalone clean SVG vector diagram representing a cloud database cluster with 1 primary node and 2 replicas. Output only valid raw <svg>...</svg> in an ```xml code block.";
    await sendPrompt(page, svgPrompt);

    const turn2 = await awaitTurnCompletion(page, url, threadId, 420000, "l2-pure-svg");
    expect(turn2.thread.messages.length).toBeGreaterThanOrEqual(4);

    await page.goto(`${url}/?thread=${encodeURIComponent(threadId)}`, { waitUntil: "networkidle" });

    // Verify vector viewer rendered pure SVG
    const svgElement = page.locator("svg").filter({ has: page.locator("rect, circle, path") });
    await expect(svgElement.first()).toBeVisible({ timeout: 15000 });

    // Part C: Draw.io XML Architecture Diagram
    const drawioPrompt = 'Create a Draw.io architecture XML diagram (<mxfile host="app.diagrams.net"><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="API Gateway" vertex="1" parent="1"><mxGeometry x="100" y="100" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>). Output it in an ```xml code block.';
    await sendPrompt(page, drawioPrompt);

    const turn3 = await awaitTurnCompletion(page, url, threadId, 420000, "l2-drawio-xml");
    expect(turn3.thread.messages.length).toBeGreaterThanOrEqual(6);

    await page.goto(`${url}/?thread=${encodeURIComponent(threadId)}`, { waitUntil: "networkidle" });

    // Verify download for Draw.io file ends in .drawio or .xml
    const allDownloadBtns = page.locator('button[title*="Download"]');
    const count = await allDownloadBtns.count();
    expect(count).toBeGreaterThan(0);

    const lastDownloadBtn = allDownloadBtns.last();
    const [drawioDownload] = await Promise.all([
      page.waitForEvent("download", { timeout: 15000 }),
      lastDownloadBtn.click()
    ]);
    const dlName = drawioDownload.suggestedFilename().toLowerCase();
    expect(dlName.endsWith(".drawio") || dlName.endsWith(".xml") || dlName.endsWith(".svg")).toBe(true);
  });
});

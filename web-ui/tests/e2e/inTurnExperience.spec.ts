import { test, expect } from "@playwright/test";
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
}

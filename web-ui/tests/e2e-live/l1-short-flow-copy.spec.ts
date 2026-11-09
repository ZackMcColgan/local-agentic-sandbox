import { test, expect } from "@playwright/test";
import { checkEngineWatchdog, createFreshSession, sendPrompt, awaitTurnCompletion, DEADLINES } from "./helpers";

test.describe("L1: Short Flow & Copy Affordance @smoke @full", () => {
  test.beforeEach(async () => {
    await checkEngineWatchdog();
  });

  test("runs short search flow, verifies copy button feedback, and completes contextual follow-up", async ({ page, baseURL }) => {
    test.setTimeout(DEADLINES.HEAVY);
    const url = baseURL || "http://192.168.50.254";

    // 1. Create fresh session
    const threadId = await createFreshSession(page, url, "L1 Short Flow");

    // 2. Turn 1: Weather query
    const prompt1 = "What's the weather today in Spanish Fort, Alabama?";
    await sendPrompt(page, prompt1);

    const turn1 = await awaitTurnCompletion(page, url, threadId, DEADLINES.NORMAL, "l1-turn1");
    expect(turn1.thread.messages.length).toBeGreaterThanOrEqual(2);

    // 3. Verify copy affordance on user message
    await page.goto(`${url}/?thread=${encodeURIComponent(threadId)}`, { waitUntil: "networkidle" });
    const copyBtn = page.locator('[data-testid="copy-user-message-btn"]').first();
    await expect(copyBtn).toBeVisible({ timeout: 10000 });
    await copyBtn.click();
    await expect(page.locator('text="Copied"').first()).toBeVisible({ timeout: 5000 });

    // 4. Turn 2: Contextual follow-up
    const prompt2 = "Is it warm enough for a short walk right now?";
    await sendPrompt(page, prompt2);

    const turn2 = await awaitTurnCompletion(page, url, threadId, DEADLINES.NORMAL, "l1-turn2");
    const lastMsg = turn2.thread.messages[turn2.thread.messages.length - 1];
    expect(lastMsg.role).toBe("assistant");
    expect(lastMsg.status === "completed" || !lastMsg.status).toBe(true);
  });
});

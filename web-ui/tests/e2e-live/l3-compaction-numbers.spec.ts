import { test, expect } from "@playwright/test";
import { checkEngineWatchdog, createFreshSession, sendPrompt, awaitTurnCompletion, getCurrentPodRestartCount, DEADLINES } from "./helpers";

test.describe("L3: Compaction & Context Numbers", () => {
  test.beforeEach(async () => {
    await checkEngineWatchdog();
  });

  test("fills context across 85K threshold, verifies compaction pill with X -> Y numbers, recalls seeded gist, and checks pod restarts", async ({ page, baseURL }) => {
    const url = baseURL || "http://192.168.50.254";
    const initialRestarts = getCurrentPodRestartCount();

    // 1. Create fresh session
    const threadId = await createFreshSession(page, url, "L3 Compaction");

    // 2. Seed unique memorable tokens
    const seedPrompt = "Mission parameter: Codename Project-Zeus-77. Secret port is 8443. Access token is ZEUS-9922. Acknowledge and repeat this exact token.";
    await sendPrompt(page, seedPrompt);

    const turn1 = await awaitTurnCompletion(page, url, threadId, DEADLINES.NORMAL, "l3-turn1-seed");
    expect(turn1.thread.messages.length).toBeGreaterThanOrEqual(2);

    // 3. Programmatic filler rounds to cross 85K threshold
    // 85,000 tokens ~ 340,000 characters
    console.log(`[L3] Injecting programmatic filler rounds to cross 85K threshold...`);
    const fillerBlock = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(1000); // ~57,000 chars

    for (let i = 0; i < 6; i++) {
      const userMsg = {
        id: `filler-u-${Date.now()}-${i}`,
        role: "user",
        content: `Background documentation chapter ${i + 1}:\n${fillerBlock}`,
        timestamp: new Date().toISOString()
      };
      const assistantMsg = {
        id: `filler-a-${Date.now()}-${i}`,
        role: "assistant",
        content: `Acknowledged chapter ${i + 1} reference text. Preserving in memory log.\n${fillerBlock}`,
        timestamp: new Date().toISOString(),
        status: "completed"
      };

      await page.request.post(`${url}/api/threads/${threadId}`, {
        data: { action: "addMessage", message: userMsg }
      });
      await page.request.post(`${url}/api/threads/${threadId}`, {
        data: { action: "addMessage", message: assistantMsg }
      });
    }

    // Verify token count before recall turn
    const checkRes = await page.request.get(`${url}/api/threads/${threadId}`);
    const checkData = await checkRes.json();
    const totalChars = checkData.thread.messages.reduce((acc: number, m: any) => acc + (m.content?.length || 0), 0);
    const estimatedTokens = Math.ceil(totalChars / 4);
    console.log(`[L3] Context loaded before recall: ${totalChars} chars (~${estimatedTokens} tokens). Threshold is 85,000 tokens.`);
    expect(estimatedTokens).toBeGreaterThanOrEqual(85000);

    // 4. Recall turn — trigger compaction and verify gist recall
    await page.goto(`${url}/?thread=${encodeURIComponent(threadId)}`, { waitUntil: "networkidle" });
    const recallPrompt = "What is the secret access token and port for Project-Zeus-77?";
    await sendPrompt(page, recallPrompt);

    const turnRecall = await awaitTurnCompletion(page, url, threadId, DEADLINES.HEAVY, "l3-turn-recall");
    const lastMsg = turnRecall.thread.messages[turnRecall.thread.messages.length - 1];
    expect(lastMsg.role).toBe("assistant");
    expect(lastMsg.status === "completed" || !lastMsg.status).toBe(true);

    // Gist recall assertion (normalizing non-breaking and standard hyphens)
    const normalizedContent = (lastMsg.content || "").replace(/[\u2010-\u2015]/g, "-");
    expect(normalizedContent).toContain("ZEUS-9922");

    // 5. Verify UI compaction note with X -> Y numbers
    await page.goto(`${url}/?thread=${encodeURIComponent(threadId)}`, { waitUntil: "networkidle" });
    const compactionNote = page.locator('[data-testid="compaction-turn-note"]').last();
    await expect(compactionNote).toBeVisible({ timeout: 15000 });
    const noteText = await compactionNote.innerText();
    console.log(`[L3] Compaction note rendered: "${noteText}"`);
    expect(noteText).toMatch(/History compacted: [\d,]+ → [\d,]+ tokens/i);

    // 6. Verify web-ui pod restart count unchanged
    const finalRestarts = getCurrentPodRestartCount();
    expect(finalRestarts).toBe(initialRestarts);
  });
});

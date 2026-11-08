import { test, expect, Page } from "@playwright/test";
import {
  checkEngineWatchdog,
  createFreshSession,
  sendPrompt,
  awaitTurnCompletion,
  getCurrentPodRestartCount,
  DEADLINES
} from "./helpers";

async function getInAppContextCounter(page: Page): Promise<string> {
  const pill = page.locator('[data-testid="context-meter-pill"]').first();
  await pill.waitFor({ state: "visible", timeout: 15000 });
  const text = (await pill.innerText()).trim();
  const title = (await pill.getAttribute("title")) || "";
  return `${text} [${title}]`;
}

test.describe("L3: Compaction & Context Numbers @full", () => {
  test.beforeEach(async () => {
    await checkEngineWatchdog();
  });

  test("fills context across 85K threshold, verifies compaction pill with X -> Y numbers, recalls seeded gist, and checks pod restarts", async ({ page, baseURL }) => {
    const url = baseURL || "http://192.168.50.254";
    const initialRestarts = getCurrentPodRestartCount();

    // 1. Create fresh session via real UI
    const threadId = await createFreshSession(page, url, "L3 Compaction");

    // 2. Round 1: Seed unique memorable tokens via real chat turn
    const seedPrompt = "Mission parameter: Codename Project-Zeus-77. Secret port is 8443. Access token is ZEUS-9922. Acknowledge and repeat this exact token.";
    console.log(`[L3] Dispatching Round 1 (Seed prompt) on thread ${threadId}...`);
    await sendPrompt(page, seedPrompt);

    const turn1 = await awaitTurnCompletion(page, url, threadId, DEADLINES.NORMAL, "l3-turn1-seed");
    expect(turn1.thread.messages.length).toBeGreaterThanOrEqual(2);

    let counter = await getInAppContextCounter(page);
    console.log(`[L3] In-app context counter after Round 1 (seed): ${counter}`);

    // 3. Grow context through real chat turns only, making model produce/retrieve tool outputs through UI
    // 5 growth rounds with ~82,000 characters (~20,500 tokens) per round:
    // Round 2: ~21K tokens
    // Round 3: ~42K tokens
    // Round 4: ~63K tokens
    // Round 5: ~84K tokens -> crosses 85K threshold (~86K tokens)
    // Round 6: ~105K tokens -> crosses 100K budget (>100K tokens)
    const telemetryFiller = "Telemetry log record and distributed consensus state sequence 0123456789. ".repeat(1100); // ~80,300 chars

    for (let roundIdx = 1; roundIdx <= 5; roundIdx++) {
      const roundNum = roundIdx + 1;
      const roundPrompt = `Use host_write_file to write 'C:\\AI\\scratch\\l3-telemetry-${roundIdx}.txt' with the word 'VERIFIED', then acknowledge telemetry block ${roundIdx} in exactly one concise sentence:\n${telemetryFiller}`;
      console.log(`[L3] Dispatching Round ${roundNum} (real chat turn + tool execution)...`);
      await sendPrompt(page, roundPrompt);

      await awaitTurnCompletion(page, url, threadId, DEADLINES.NORMAL, `l3-round${roundNum}`);
      counter = await getInAppContextCounter(page);
      console.log(`[L3] In-app context counter after Round ${roundNum}: ${counter}`);
    }

    // 4. Recall turn — triggers compaction / recalls seeded gist across compacted history
    const recallPrompt = "What is the secret access token and port for Project-Zeus-77? Answer concisely.";
    console.log(`[L3] Dispatching Recall turn across compacted context...`);
    await sendPrompt(page, recallPrompt);

    const turnRecall = await awaitTurnCompletion(page, url, threadId, DEADLINES.HEAVY, "l3-turn-recall");
    const lastMsg = turnRecall.thread.messages[turnRecall.thread.messages.length - 1];
    expect(lastMsg.role).toBe("assistant");
    expect(lastMsg.status === "completed" || !lastMsg.status).toBe(true);

    counter = await getInAppContextCounter(page);
    console.log(`[L3] In-app context counter after Recall turn: ${counter}`);

    // Gist recall assertion (normalizing non-breaking and standard hyphens)
    const normalizedContent = (lastMsg.content || "").replace(/[\u2010-\u2015]/g, "-");
    expect(normalizedContent).toContain("ZEUS-9922");
    expect(normalizedContent).toContain("8443");
    console.log(`[L3] Seeded gist recalled successfully: "ZEUS-9922" and "8443" present in final response.`);

    // 5. Verify UI compaction note with before -> after numbers
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

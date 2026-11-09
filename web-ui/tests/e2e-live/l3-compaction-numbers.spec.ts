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

    // 2. Round 1: Seed unique memorable configuration tokens (Fresh thread ~1K-4K tier)
    const seedPrompt = "Configuration registry: Project name is Project-Zeus-77, cluster identifier is ZEUS-9922, and primary service port is 8443. Please confirm these settings in one sentence.";
    console.log(`[L3] Dispatching Round 1 (Seed prompt, fresh thread tier) on thread ${threadId}...`);
    await sendPrompt(page, seedPrompt);

    const turn1 = await awaitTurnCompletion(page, url, threadId, DEADLINES.NORMAL, "l3-turn1-seed");
    expect(turn1.thread.messages.length).toBeGreaterThanOrEqual(2);

    let counter = await getInAppContextCounter(page);
    console.log(`[L3] In-app context counter after Round 1 (seed): ${counter}`);

    // 3. Round 2: Real chat turn growing context to mid tier (~50K tokens)
    // ~185,000 characters ~ 46,250 tokens + ~1,500 prior = ~48K tokens
    const fillerMid = "Distributed telemetry log record sequence alpha beta gamma delta 0123456789. ".repeat(2400); // ~184,800 chars
    const promptMid = `Use host_write_file to write 'C:\\AI\\scratch\\l3-telemetry-mid.txt' with 'OK', then acknowledge this mid-tier telemetry block in one concise sentence:\n${fillerMid}`;
    console.log(`[L3] Dispatching Round 2 (Mid tier ~50K tokens)...`);
    await sendPrompt(page, promptMid);

    await awaitTurnCompletion(page, url, threadId, DEADLINES.HEAVY, "l3-round2-mid");
    counter = await getInAppContextCounter(page);
    console.log(`[L3] In-app context counter after Round 2 (mid tier): ${counter}`);

    // 4. Round 3: Real chat turn crossing the 85K compaction threshold (~88K tokens)
    // ~155,000 characters ~ 38,750 tokens + ~48K prior = ~87K tokens (>85K trigger!)
    const fillerThreshold = "Distributed telemetry log record sequence epsilon zeta eta theta 0123456789. ".repeat(2000); // ~154,000 chars
    const promptThreshold = `Use host_write_file to write 'C:\\AI\\scratch\\l3-telemetry-threshold.txt' with 'OK', then acknowledge this 85K-threshold telemetry block in one concise sentence:\n${fillerThreshold}`;
    console.log(`[L3] Dispatching Round 3 (85K threshold tier)...`);
    await sendPrompt(page, promptThreshold);

    await awaitTurnCompletion(page, url, threadId, DEADLINES.HEAVY, "l3-round3-threshold");
    counter = await getInAppContextCounter(page);
    console.log(`[L3] In-app context counter after Round 3 (85K threshold): ${counter}`);

    // 5. Round 4: Real chat turn pushing into full 100K budget / triggering compaction ladder
    const fillerBudget = "Distributed telemetry log record sequence iota kappa lambda mu 0123456789. ".repeat(800); // ~60,000 chars
    const promptBudget = `Use host_write_file to write 'C:\\AI\\scratch\\l3-telemetry-budget.txt' with 'OK', then acknowledge this 100K-budget telemetry block in one concise sentence:\n${fillerBudget}`;
    console.log(`[L3] Dispatching Round 4 (100K budget & compaction tier)...`);
    await sendPrompt(page, promptBudget);

    await awaitTurnCompletion(page, url, threadId, DEADLINES.HEAVY, "l3-round4-budget");
    counter = await getInAppContextCounter(page);
    console.log(`[L3] In-app context counter after Round 4 (100K budget / compaction): ${counter}`);

    // 6. Round 5: Recall turn — recalls seeded gist across compacted history
    const recallPrompt = "What is the cluster identifier and service port for Project-Zeus-77? Answer concisely.";
    console.log(`[L3] Dispatching Round 5 (Recall turn across compacted context)...`);
    await sendPrompt(page, recallPrompt);

    const turnRecall = await awaitTurnCompletion(page, url, threadId, DEADLINES.HEAVY, "l3-turn-recall");
    const lastMsg = turnRecall.thread.messages[turnRecall.thread.messages.length - 1];
    expect(lastMsg.role).toBe("assistant");
    expect(lastMsg.status === "completed" || !lastMsg.status).toBe(true);

    counter = await getInAppContextCounter(page);
    console.log(`[L3] In-app context counter after Round 5 (recall): ${counter}`);

    // Gist recall assertion (normalizing non-breaking and standard hyphens)
    const normalizedContent = (lastMsg.content || "").replace(/[\u2010-\u2015]/g, "-");
    expect(normalizedContent).toContain("ZEUS-9922");
    expect(normalizedContent).toContain("8443");
    console.log(`[L3] Seeded gist recalled successfully: "ZEUS-9922" and "8443" present in final response.`);

    // 7. Verify UI compaction note with before -> after numbers
    const compactionNote = page.locator('[data-testid="compaction-turn-note"]').last();
    await expect(compactionNote).toBeVisible({ timeout: 15000 });
    const noteText = await compactionNote.innerText();
    console.log(`[L3] Compaction note rendered: "${noteText}"`);
    expect(noteText).toMatch(/History compacted: [\d,]+ → [\d,]+ tokens/i);

    // 8. Verify web-ui pod restart count unchanged
    const finalRestarts = getCurrentPodRestartCount();
    expect(finalRestarts).toBe(initialRestarts);
  });
});

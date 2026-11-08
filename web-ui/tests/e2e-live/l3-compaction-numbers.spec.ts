import { test, expect, Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
  checkEngineWatchdog,
  createFreshSession,
  sendPrompt,
  awaitTurnCompletion,
  getCurrentPodRestartCount,
  DEADLINES
} from "./helpers";

const SCRATCH_DIR = "C:\\AI\\scratch";
const CORPUS_FILES = [
  "l3-corpus-1.txt",
  "l3-corpus-2.txt",
  "l3-corpus-3.txt",
  "l3-corpus-4.txt"
];

async function getInAppContextCounter(page: Page): Promise<string> {
  const pill = page.locator('[data-testid="context-meter-pill"]').first();
  await pill.waitFor({ state: "visible", timeout: 15000 });
  const text = (await pill.innerText()).trim();
  const title = (await pill.getAttribute("title")) || "";
  return `${text} [${title}]`;
}

test.describe("L3: Compaction & Context Numbers @full", () => {
  test.beforeAll(() => {
    if (!fs.existsSync(SCRATCH_DIR)) {
      fs.mkdirSync(SCRATCH_DIR, { recursive: true });
    }
    // Prepare 4 corpus files, each ~95,000 characters (~23,750 tokens)
    // 4 files * 95,000 chars = 380,000 chars (~95,000 tokens)
    // Plus system prompt + seed prompt + assistant turns = >100,000 tokens total
    for (let i = 0; i < CORPUS_FILES.length; i++) {
      const filePath = path.join(SCRATCH_DIR, CORPUS_FILES[i]);
      const block = `Section ${i + 1} telemetry stream and distributed consensus log payload block.\n` +
        `Data: ${"0123456789abcdefghijklmnopqrstuvwxyz".repeat(2500)}\n`;
      const fullContent = block.repeat(Math.ceil(95000 / block.length)).slice(0, 95000);
      fs.writeFileSync(filePath, fullContent, "utf8");
    }
  });

  test.afterAll(() => {
    for (const file of CORPUS_FILES) {
      try {
        const p = path.join(SCRATCH_DIR, file);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {}
    }
  });

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

    // 3. Rounds 2 through 5: Grow context through real chat turns retrieving large tool outputs via host_read_file
    for (let i = 0; i < CORPUS_FILES.length; i++) {
      const roundNum = i + 2;
      const fileName = CORPUS_FILES[i];
      const readPrompt = `Use host_read_file to inspect the file 'C:\\AI\\scratch\\${fileName}' and summarize its contents in exactly one sentence.`;
      console.log(`[L3] Dispatching Round ${roundNum} (real tool retrieve: ${fileName})...`);
      await sendPrompt(page, readPrompt);

      await awaitTurnCompletion(page, url, threadId, DEADLINES.NORMAL, `l3-round${roundNum}-read`);
      counter = await getInAppContextCounter(page);
      console.log(`[L3] In-app context counter after Round ${roundNum}: ${counter}`);
    }

    // 4. Round 6: Recall turn — trigger compaction / recall seeded gist across compacted history
    const recallPrompt = "What is the secret access token and port for Project-Zeus-77? Answer concisely.";
    console.log(`[L3] Dispatching Round 6 (Recall turn across compacted context)...`);
    await sendPrompt(page, recallPrompt);

    const turnRecall = await awaitTurnCompletion(page, url, threadId, DEADLINES.HEAVY, "l3-turn-recall");
    const lastMsg = turnRecall.thread.messages[turnRecall.thread.messages.length - 1];
    expect(lastMsg.role).toBe("assistant");
    expect(lastMsg.status === "completed" || !lastMsg.status).toBe(true);

    counter = await getInAppContextCounter(page);
    console.log(`[L3] In-app context counter after Round 6 (recall): ${counter}`);

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

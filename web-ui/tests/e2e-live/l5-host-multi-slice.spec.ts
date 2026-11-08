import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { checkEngineWatchdog, createFreshSession, sendPrompt, awaitTurnCompletion, DEADLINES } from "./helpers";

test.describe("L5: Multi-Slice Host Job", () => {
  test.beforeEach(async () => {
    await checkEngineWatchdog();
  });

  test("dispatches single prompt to write 3 host files, reads back via host tools, and verifies bytes on disk", async ({ page, baseURL }) => {
    test.setTimeout(DEADLINES.HEAVY * 2);
    const url = baseURL || "http://192.168.50.254";

    const scratchDir = "C:\\AI\\scratch";
    fs.mkdirSync(scratchDir, { recursive: true });

    // Clean up test files if they already exist
    const alphaPath = path.join(scratchDir, "alpha.txt");
    const betaPath = path.join(scratchDir, "beta.json");
    const gammaPath = path.join(scratchDir, "gamma.ps1");
    try { fs.unlinkSync(alphaPath); } catch {}
    try { fs.unlinkSync(betaPath); } catch {}
    try { fs.unlinkSync(gammaPath); } catch {}

    // 1. Create fresh session
    const threadId = await createFreshSession(page, url, "L5 Host Multi-Slice");

    // 2. Multi-slice host prompt
    const prompt = `Using host tools, perform this exact sequence of actions:
1. Write 'C:\\AI\\scratch\\alpha.txt' containing 'ALPHA_TOKEN_91823'.
2. Write 'C:\\AI\\scratch\\beta.json' containing '{"service":"orchestrator","active":true,"code":4021}'.
3. Write 'C:\\AI\\scratch\\gamma.ps1' containing 'Write-Output "GAMMA_HOST_SUCCESS"'.
4. Read back 'C:\\AI\\scratch\\alpha.txt' using host_read_file to confirm its content.
Confirm when all three files are written.`;

    await sendPrompt(page, prompt);

    const turn = await awaitTurnCompletion(page, url, threadId, DEADLINES.HEAVY, "l5-host-turn");
    const lastMsg = turn.thread.messages[turn.thread.messages.length - 1];

    expect(lastMsg.role).toBe("assistant");
    expect(lastMsg.status === "completed" || !lastMsg.status).toBe(true);

    // 3. Verify files on disk on host
    expect(fs.existsSync(alphaPath)).toBe(true);
    expect(fs.readFileSync(alphaPath, "utf8").trim()).toBe("ALPHA_TOKEN_91823");

    expect(fs.existsSync(betaPath)).toBe(true);
    const betaJson = JSON.parse(fs.readFileSync(betaPath, "utf8"));
    expect(betaJson.service).toBe("orchestrator");
    expect(betaJson.code).toBe(4021);

    expect(fs.existsSync(gammaPath)).toBe(true);
    expect(fs.readFileSync(gammaPath, "utf8")).toContain("GAMMA_HOST_SUCCESS");
  });
});

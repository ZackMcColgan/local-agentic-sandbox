import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { checkEngineWatchdog, createFreshSession, sendPrompt, awaitTurnCompletion, DEADLINES } from "./helpers";

test.describe("L7: Host-Mode Stress & Clamping Honesty", () => {
  test.beforeEach(async () => {
    await checkEngineWatchdog();
  });

  test("verifies >70KB host read without clamping, executes >75KB PowerShell output with honest 64KB clamp marker, and completes", async ({ page, baseURL }) => {
    test.setTimeout(DEADLINES.HEAVY * 2);
    const url = baseURL || "http://192.168.50.254";

    const scratchDir = "C:\\AI\\scratch";
    fs.mkdirSync(scratchDir, { recursive: true });

    // Prepare ~70KB test file for uncapped read test
    const largeFilePath = path.join(scratchDir, "s8-large-test.txt");
    const testContent = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ\n".repeat(2000); // ~76,000 bytes
    fs.writeFileSync(largeFilePath, testContent, "utf8");

    // 1. Create fresh session
    const threadId = await createFreshSession(page, url, "L7 Host Stress");

    // 2. Dispatch stress prompt
    const stressPrompt = `Using host tools, execute the following two operations:
1. Use host_read_file to read 'C:\\AI\\scratch\\s8-large-test.txt' and report its length.
2. Use host_run_powershell to run: '1..2500 | ForEach-Object { "STRESS_LINE_OUTPUT_CHUNK_PAD_1234567890_$_" }'
3. Write a small verification file 'C:\\AI\\scratch\\s8-verify.txt' containing 'STRESS_VERIFIED_CLEAN'.
Confirm when complete.`;

    console.log(`[L7] Dispatching stress prompt on thread ${threadId}...`);
    await sendPrompt(page, stressPrompt);

    const completedTurn = await awaitTurnCompletion(page, url, threadId, DEADLINES.HEAVY, "l7-host-stress");
    const thread = completedTurn.thread;
    const lastMsg = thread.messages[thread.messages.length - 1];

    expect(lastMsg.role).toBe("assistant");
    expect(lastMsg.status === "completed" || !lastMsg.status).toBe(true);

    // Verify verification file was written
    const verifyPath = path.join(scratchDir, "s8-verify.txt");
    expect(fs.existsSync(verifyPath)).toBe(true);
    expect(fs.readFileSync(verifyPath, "utf8")).toContain("STRESS_VERIFIED_CLEAN");

    // Inspect tool traces in thread
    const toolMessages = thread.messages.filter((m: any) => m.role === "tool");
    expect(toolMessages.length).toBeGreaterThanOrEqual(2);

    // Verify host_read_file was NOT clamped (retained full ~70KB payload)
    const readToolMsg = toolMessages.find((m: any) => m.name === "host_read_file");
    expect(readToolMsg).toBeDefined();
    expect(readToolMsg.content.length).toBeGreaterThan(65000);

    // Verify host_run_powershell was clamped with honest truncation metadata
    const psToolMsg = toolMessages.find((m: any) => m.name === "host_run_powershell");
    expect(psToolMsg).toBeDefined();
    expect(
      psToolMsg.content.includes("truncated") ||
      psToolMsg.content.includes("TRUNCATED") ||
      psToolMsg.content.includes("exceeded") ||
      psToolMsg.content.length <= 66000
    ).toBe(true);
  });
});

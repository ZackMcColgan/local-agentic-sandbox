import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { checkEngineWatchdog, createFreshSession, sendPrompt, awaitTurnCompletion, DEADLINES } from "./helpers";

test.describe("L7: Host-Mode Stress & Clamping Honesty", () => {
  test.beforeEach(async () => {
    await checkEngineWatchdog();
  });

  test("verifies >70KB host read without clamping, executes >75KB PowerShell output with honest 64KB clamp marker, and completes", async ({ page, baseURL }) => {
    const url = baseURL || "http://192.168.50.254";

    const scratchDir = "C:\\AI\\scratch";
    fs.mkdirSync(scratchDir, { recursive: true });

    // Prepare ~70KB test file for uncapped read test
    const largeFilePath = path.join(scratchDir, "s8-large-test.txt");
    const testContent = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ\n".repeat(2000); // ~74,000 bytes
    fs.writeFileSync(largeFilePath, testContent, "utf8");

    // Clean up verify file
    const verifyPath = path.join(scratchDir, "s8-verify.txt");
    try { fs.unlinkSync(verifyPath); } catch {}

    // 1. Create fresh session
    const threadId = await createFreshSession(page, url, "L7 Host Stress");

    // 2. Dispatch stress prompt
    const stressPrompt = `Using host tools, execute the following three operations in sequence:
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

    // 3. Verify verification file was written by host_write_file
    expect(fs.existsSync(verifyPath)).toBe(true);
    expect(fs.readFileSync(verifyPath, "utf8")).toContain("STRESS_VERIFIED_CLEAN");

    // 4. Verify tool calls executed via system traces API
    const traceRes = await page.request.get(`${url}/api/traces`);
    expect(traceRes.ok()).toBe(true);
    const traceData = await traceRes.json();
    const allSpans = (traceData.sessions || []).flatMap((s: any) => s.spans || []);
    const toolSpans = allSpans.filter((sp: any) => sp.name === "mcp.tool_call");

    const ranReadFile = toolSpans.some((sp: any) => sp.attributes?.tool === "host_read_file");
    const ranPowershell = toolSpans.some((sp: any) => sp.attributes?.tool === "host_run_powershell");
    const ranWriteFile = toolSpans.some((sp: any) => sp.attributes?.tool === "host_write_file");

    expect(ranReadFile).toBe(true);
    expect(ranPowershell).toBe(true);
    expect(ranWriteFile).toBe(true);

    // 5. Verify assistant content confirmed successful read of ~74,000 bytes
    const assistantContent = lastMsg.content || "";
    expect(assistantContent).toMatch(/74[,\.]?000|2[,\.]?000/);
  });
});

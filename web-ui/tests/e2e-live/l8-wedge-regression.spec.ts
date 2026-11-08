import { test, expect } from "@playwright/test";
import { checkEngineWatchdog, createFreshSession, sendPrompt, awaitTurnCompletion, DEADLINES } from "./helpers";

test.describe("L8: Wedging Regression (Single Massive Tool Argument)", () => {
  test.beforeEach(async () => {
    await checkEngineWatchdog();
  });

  test("defends against engine wedging when model is asked to emit a massive 70KB tool call payload in a single turn", async ({ page, baseURL }) => {
    const url = baseURL || "http://192.168.50.254";

    // 1. Create fresh session
    const threadId = await createFreshSession(page, url, "L8 Wedge Regression");

    // 2. Dispatch prompt asking to write a massive ~70KB file in a single tool call
    const massivePrompt = `Use host_write_file to write the file 'C:\\AI\\scratch\\wedge-test.txt'. The content must be a continuous single string of exactly 70,000 characters of repeating 'A1B2C3D4' characters. You must provide all 70,000 characters directly inside the tool arguments in a single tool call.`;

    console.log(`[L8] Dispatching massive tool argument prompt to thread ${threadId}...`);
    await sendPrompt(page, massivePrompt);

    // 3. Await turn outcome with 14m deadline (within 15m project timeout)
    let turnError: any = null;
    let turnResult: any = null;

    try {
      turnResult = await awaitTurnCompletion(page, url, threadId, DEADLINES.WEDGING_LIMIT, "l8-wedge-test");
    } catch (err: any) {
      turnError = err;
    }

    // 4. Critical Invariant: Verify Strata slot 0 is NOT wedged
    console.log(`[L8] Verifying Strata LLM engine slot 0 is free and not wedged...`);
    await checkEngineWatchdog();

    // If turn completed, check status is valid
    if (turnResult) {
      const lastMsg = turnResult.thread.messages[turnResult.thread.messages.length - 1];
      expect(lastMsg.role).toBe("assistant");
      expect(["completed", "incomplete"]).toContain(lastMsg.status || "completed");
      console.log(`[L8] Turn completed cleanly with status '${lastMsg.status || "completed"}'.`);
    } else {
      console.log(`[L8] Turn ended with error:`, turnError?.message);
      expect(turnError?.classification).not.toBe("ENGINE-WEDGED");
    }
  });
});

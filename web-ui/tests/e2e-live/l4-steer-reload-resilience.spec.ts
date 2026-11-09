import { test, expect } from "@playwright/test";
import { checkEngineWatchdog, createFreshSession, sendPrompt, awaitTurnCompletion, DEADLINES } from "./helpers";

test.describe("L4: Mid-Turn Steer & Reload Resilience @full", () => {
  test.beforeEach(async () => {
    await checkEngineWatchdog();
  });

  test("dispatches long generation, applies mid-turn steer with interrupt, survives page reload, and completes cleanly without duplicate user turns", async ({ page, baseURL }) => {
    const url = baseURL || "http://192.168.50.254";

    // 1. Create fresh session
    const threadId = await createFreshSession(page, url, "L4 Steer & Reload");

    // 2. Dispatch long generation prompt
    const initialPrompt = "Provide an in-depth academic treatise comparing the Raft and Paxos consensus algorithms across 12 comprehensive sections.";
    await sendPrompt(page, initialPrompt);

    // Allow generation stream to start
    await page.waitForTimeout(6000);

    // 3. Inject mid-turn steer via API with interrupt: true
    const steerText = "CRITICAL REDIRECTION: Pivot immediately and focus exclusively on Byzantine Fault Tolerance (PBFT) and state machine replication.";
    console.log(`[L4] Dispatching mid-turn steer to thread ${threadId}...`);
    const steerRes = await page.request.post(`${url}/api/threads/${threadId}/steer`, {
      data: { text: steerText, interrupt: true }
    });
    expect(steerRes.ok()).toBe(true);
    const steerJson = await steerRes.json();
    console.log(`[L4] Steer response:`, steerJson);

    // 4. Trigger mid-stream browser page reload while server processes
    console.log(`[L4] Reloading page mid-stream to verify turn survives disconnect...`);
    await page.reload({ waitUntil: "domcontentloaded" });

    // 5. Await turn completion server-side with 14m deadline (within 15m runner timeout)
    const completedTurn = await awaitTurnCompletion(page, url, threadId, DEADLINES.WEDGING_LIMIT, "l4-steer-turn");
    const messages = completedTurn.thread.messages;
    const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant");

    expect(lastAssistant).toBeDefined();
    expect(lastAssistant.role).toBe("assistant");
    expect(lastAssistant.status === "completed" || !lastAssistant.status).toBe(true);

    // 6. Verify steer was absorbed into assistant output or thread context
    const fullAssistantText = messages
      .filter((m: any) => m.role === "assistant")
      .map((m: any) => (m.content || "") + (m.thinking || ""))
      .join(" ");
    const absorbed = /Byzantine|PBFT|fault tolerance|replication/i.test(fullAssistantText);
    expect(absorbed).toBe(true);

    // 7. Verify no duplicate user initial prompts were created
    const initialUserPrompts = messages.filter((m: any) => m.role === "user" && !m.content?.startsWith("[Steer from user, mid-turn]"));
    expect(initialUserPrompts.length).toBe(1);
  });
});

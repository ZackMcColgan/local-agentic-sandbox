import { Page } from "@playwright/test";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

export const DEADLINES = {
  FAST: 60000,           // 1m
  NORMAL: 300000,        // 5m
  HEAVY: 600000,         // 10m
  WEDGING_LIMIT: 600000  // 10m (leaves 5m budget for watchdog verification within 15m runner deadline)
};

export type HangClassification =
  | "TURN-DIED"
  | "STREAM-DIED-TURN-LIVED"
  | "ENGINE-WEDGED"
  | "UI-HUNG"
  | "QUEUED";

let stopRecoveryCount = 0;

export async function checkEngineWatchdog(baseUrl = "http://192.168.50.254"): Promise<void> {
  // 1. Wait <= 120s for slot to be idle
  const start = Date.now();
  while (Date.now() - start < 120000) {
    try {
      const res = await fetch("http://127.0.0.1:8080/slots", { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const slots = await res.json();
        const busy = slots.some((s: any) => s.is_processing);
        if (!busy) return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 4000));
  }

  // 2. Addendum A §4: If still busy after 120s, attempt product API stop recovery (max 2 per run)
  if (stopRecoveryCount < 2) {
    stopRecoveryCount++;
    console.warn(`[WATCHDOG RECOVERY #${stopRecoveryCount}] Slot busy after 120s. Invoking product API stop recovery...`);
    try {
      const thRes = await fetch(`${baseUrl}/api/threads`);
      if (thRes.ok) {
        const thData = await thRes.json();
        const activeThreads = thData.threads?.filter((t: any) => t.status === "active" || t.status === "running") || [];
        for (const active of activeThreads) {
          console.warn(`[WATCHDOG RECOVERY] Stopping active occupant thread '${active.id}' via POST /api/threads/${active.id}...`);
          await fetch(`${baseUrl}/api/threads/${active.id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "stop" })
          });
        }
      }
    } catch (e: any) {
      console.warn(`[WATCHDOG RECOVERY] Product stop call failed: ${e.message}`);
    }

    // Wait <= 60s for slot to clear after stop
    const stopWaitStart = Date.now();
    while (Date.now() - stopWaitStart < 60000) {
      try {
        const res = await fetch("http://127.0.0.1:8080/slots", { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const slots = await res.json();
          const busy = slots.some((s: any) => s.is_processing);
          if (!busy) {
            console.log(`[WATCHDOG RECOVERY] Slot cleared successfully after product stop.`);
            return;
          }
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  throw new Error("[ENGINE-WEDGED] Strata LLM engine slot remained busy after product API stop recovery. Watchdog aborting.");
}

export function getCurrentPodRestartCount(): number {
  try {
    const out = execSync(
      'kubectl get pod -l app=web-ui -n local-agentic-sandbox -o jsonpath="{.items[0].status.containerStatuses[0].restartCount}"',
      { encoding: "utf8" }
    ).trim();
    return parseInt(out || "0", 10);
  } catch {
    return 0;
  }
}

export async function createFreshSession(page: Page, baseUrl: string, title = "Live E2E Session"): Promise<string> {
  const res = await page.request.post(`${baseUrl}/api/threads`, {
    data: { title }
  });
  if (!res.ok()) {
    throw new Error(`Failed to create thread via API: HTTP ${res.status()}`);
  }
  const data = await res.json();
  const threadId = data?.thread?.id;
  if (!threadId) {
    throw new Error("No thread ID returned from /api/threads");
  }

  await page.goto(`${baseUrl}/?thread=${encodeURIComponent(threadId)}`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 15000 });
  return threadId;
}

export async function sendPrompt(page: Page, prompt: string): Promise<void> {
  const composer = page.locator('textarea, [contenteditable="true"]').first();
  await composer.fill(prompt);
  await page.waitForTimeout(300);

  const sendBtn = page.locator('button[aria-label="Send message"], button[title="Send message"]').first();
  if (await sendBtn.count() > 0 && await sendBtn.isEnabled()) {
    await sendBtn.click();
  } else {
    await composer.press("Enter");
  }
}

export async function awaitTurnCompletion(
  page: Page,
  baseUrl: string,
  threadId: string,
  timeoutMs: number,
  specName: string
): Promise<{ thread: any; durationSec: number }> {
  const start = Date.now();
  let lastHeartbeat = Date.now();
  let lastObservedStatus: string | undefined;
  let lastContentLength = 0;
  let sawActivity = false;

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await page.request.get(`${baseUrl}/api/threads/${threadId}`);
      if (res.ok()) {
        const data = await res.json();
        const thread = data.thread;
        const activeTurn = data.activeTurn;
        const lastMsg = thread?.messages?.[thread?.messages?.length - 1];
        const lastAssistant = [...(thread?.messages || [])].reverse().find((m: any) => m.role === "assistant");
        lastObservedStatus = lastAssistant?.status || lastMsg?.status;
        lastContentLength = lastAssistant?.content?.length || 0;

        if (activeTurn || lastAssistant) {
          sawActivity = true;
        }

        // Addendum A §2: Heartbeat line logged at least every 60s
        if (Date.now() - lastHeartbeat >= 60000) {
          lastHeartbeat = Date.now();
          const elapsed = Math.round((Date.now() - start) / 1000);
          console.log(`[${specName}] waiting… elapsed ${elapsed}s, state: ${lastObservedStatus || (activeTurn ? 'activeTurn' : 'unknown')}, len: ${lastContentLength}`);
        }

        // Turn completed cleanly when activeTurn is gone and an assistant message is completed
        if (sawActivity && !activeTurn && lastAssistant && (lastAssistant.status === "completed" || !lastAssistant.status)) {
          return {
            thread,
            durationSec: parseFloat(((Date.now() - start) / 1000).toFixed(1))
          };
        }
      }
    } catch {}

    await page.waitForTimeout(3000);
  }

  // Timeout reached — Addendum A §3: capture evidence & classify hang
  const evidenceDir = path.resolve(process.cwd(), "playwright-live-report/evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const screenshotPath = path.join(evidenceDir, `${specName}-hang-${Date.now()}.png`);
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch {}

  let slotBusy = false;
  try {
    const slotRes = await fetch("http://127.0.0.1:8080/slots", { signal: AbortSignal.timeout(3000) });
    if (slotRes.ok) {
      const slots = await slotRes.json();
      slotBusy = slots.some((s: any) => s.is_processing);
    }
  } catch {}

  let isTrulyWedged = false;
  if (slotBusy) {
    // Timeout & No-Response Doctrine: Check if slot accepts stop recovery or is permanently wedged
    console.warn(`[WATCHDOG] Slot busy upon timeout. Testing if engine is wedged via product stop recovery...`);
    try {
      await fetch(`${baseUrl}/api/threads/${threadId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" })
      });
      await new Promise((r) => setTimeout(r, 4000));
      const verifyRes = await fetch("http://127.0.0.1:8080/slots", { signal: AbortSignal.timeout(3000) });
      if (verifyRes.ok) {
        const verifySlots = await verifyRes.json();
        isTrulyWedged = verifySlots.some((s: any) => s.is_processing);
      }
    } catch {
      isTrulyWedged = true;
    }
  }

  const podRestarts = getCurrentPodRestartCount();

  let classification: HangClassification = "TURN-DIED";
  if (isTrulyWedged) {
    classification = "ENGINE-WEDGED";
  } else if (lastObservedStatus === "streaming" && lastContentLength > 0) {
    classification = "STREAM-DIED-TURN-LIVED";
  } else if (lastObservedStatus === "streaming") {
    classification = "TURN-DIED";
  } else {
    classification = "UI-HUNG";
  }

  const err = new Error(
    `[${classification}] Spec '${specName}' timed out after ${timeoutMs / 1000}s on thread '${threadId}'. ` +
    `Observed status: ${lastObservedStatus}, Content len: ${lastContentLength}, Slot busy: ${slotBusy}, ` +
    `Pod restarts: ${podRestarts}, Evidence saved to: ${screenshotPath}`
  );
  (err as any).classification = classification;
  (err as any).threadId = threadId;
  throw err;
}

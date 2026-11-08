import { Page } from "@playwright/test";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

export const DEADLINES = {
  FAST: 60000,          // 60s
  NORMAL: 180000,       // 3m
  HEAVY: 360000,        // 6m
  WEDGING_LIMIT: 480000 // 8m
};

export type HangClassification =
  | "TURN-DIED"
  | "STREAM-DIED-TURN-LIVED"
  | "ENGINE-WEDGED"
  | "UI-HUNG"
  | "QUEUED";

export async function checkEngineWatchdog(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 120000) {
    try {
      const res = await fetch("http://127.0.0.1:8080/slots", { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const slots = await res.json();
        const busy = slots.some((s: any) => s.is_processing);
        if (!busy) {
          return;
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 4000));
  }

  throw new Error("[ENGINE-WEDGED] Strata LLM engine slot remained busy for > 2 minutes between specs. Watchdog aborting.");
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
  // Create thread server-side to ensure stable ID
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

  // Click send button or press enter
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
        lastObservedStatus = lastMsg?.status;
        lastContentLength = lastMsg?.content?.length || 0;

        if (activeTurn || (lastMsg && lastMsg.role === "assistant")) {
          sawActivity = true;
        }

        // Turn completed cleanly when activeTurn is gone and last message is assistant
        if (sawActivity && !activeTurn && lastMsg?.role === "assistant") {
          return {
            thread,
            durationSec: parseFloat(((Date.now() - start) / 1000).toFixed(1))
          };
        }
      }
    } catch {}

    await page.waitForTimeout(3000);
  }

  // Timeout reached — capture evidence & classify hang
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

  const podRestarts = getCurrentPodRestartCount();

  let classification: HangClassification = "TURN-DIED";
  if (slotBusy) {
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

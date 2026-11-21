import { startDaemon } from "./lib/subagents/schedulerDaemon";

const GLOBAL_KEY = "__schedulerDaemonStarted";

type GlobalWithScheduler = typeof globalThis & {
  [GLOBAL_KEY]?: boolean;
};

/**
 * Next.js instrumentation hook. Starts the in-process scheduler daemon once
 * in the Node.js runtime when SCHEDULER_DAEMON_ENABLED === "true".
 */
export async function register(
  startFn: () => Promise<void> = () => startDaemon()
): Promise<boolean> {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") {
    return false;
  }
  if (process.env.SCHEDULER_DAEMON_ENABLED !== "true") {
    return false;
  }
  const g = globalThis as GlobalWithScheduler;
  if (g[GLOBAL_KEY]) {
    return false;
  }
  g[GLOBAL_KEY] = true;
  void startFn().catch((err) => {
    console.error("[instrumentation] Scheduler daemon error:", err);
  });
  return true;
}

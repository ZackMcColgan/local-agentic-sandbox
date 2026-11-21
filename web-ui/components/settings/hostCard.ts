export type HostCardRunnerState = "DISABLED" | "READY" | "UNAVAILABLE" | "MISMATCH";

export interface HostCardPresentation {
  stripLabel: string;
  badgeLabel: string;
  reasonText: string;
  dotClass: string;
  badgeClass: string;
}

export function getHostCardPresentation(settings: {
  hostAccessEnabled: boolean;
  runnerAvailable: boolean;
  runnerState?: HostCardRunnerState;
  runnerReason?: string;
}): HostCardPresentation {
  if (!settings.hostAccessEnabled) {
    return {
      stripLabel: "Off",
      badgeLabel: "Disabled",
      reasonText: "Host access is disabled. New chat threads will not offer host tools.",
      dotClass: "bg-slate-400 dark:bg-zinc-600",
      badgeClass:
        "border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-850 text-slate-600 dark:text-zinc-400",
    };
  }
  if (settings.runnerState === "MISMATCH") {
    return {
      stripLabel: "Runner mismatch",
      badgeLabel: "Version Mismatch",
      reasonText:
        settings.runnerReason ||
        "Host runner responded but does not match the expected build. Update the host runner to restore access.",
      dotClass: "bg-amber-500",
      badgeClass:
        "border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300",
    };
  }
  if (settings.runnerState === "READY" || settings.runnerAvailable) {
    return {
      stripLabel: "Connected",
      badgeLabel: "Active",
      reasonText:
        "Host tools (read, write, bash/powershell) are enabled across chat threads. Default is ON.",
      dotClass: "bg-emerald-500",
      badgeClass:
        "border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400",
    };
  }
  return {
    stripLabel: "Runner offline",
    badgeLabel: "Runner Offline",
    reasonText:
      "Host tools (read, write, bash/powershell) are enabled across chat threads. Default is ON.",
    dotClass: "bg-zinc-500",
    badgeClass:
      "border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40 text-zinc-700 dark:text-zinc-400",
  };
}

export function formatEngineActionMessage(
  action: "start" | "stop" | "restart",
  ok: boolean,
  status: number,
  json: { success?: boolean; message?: string; error?: string; vramReleased?: boolean }
): string {
  if (!ok || json.success === false) {
    if (status === 404 || status === 405 || status === 501) {
      return "VRAM unload / engine control is not applicable to this engine.";
    }
    return json.error || `Engine ${action} failed (HTTP ${status}).`;
  }
  if (json.message) {
    return json.message;
  }
  if (action === "stop") {
    return json.vramReleased ? "Engine stopped and VRAM released." : "Engine stopped.";
  }
  if (action === "start") {
    return "Engine starting up...";
  }
  return "Engine restarted.";
}

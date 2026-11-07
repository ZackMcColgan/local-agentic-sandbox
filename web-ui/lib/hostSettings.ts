import fs from "fs";
import path from "path";
import { resolveSettingsDir } from "./notifications";
import { getHostRunnerBaseUrl } from "./hostMode";

export interface HostSettings {
  allowUnattendedHostGit: boolean;
}

export function getHostSettingsFilePath(): string {
  const dir = resolveSettingsDir();
  return path.join(dir, "host-settings.json");
}

export function getHostSettings(): HostSettings {
  try {
    const filePath = getHostSettingsFilePath();
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return {
        allowUnattendedHostGit: Boolean(data?.allowUnattendedHostGit)
      };
    }
  } catch {}

  return {
    allowUnattendedHostGit: false
  };
}

export function setHostSettings(updates: Partial<HostSettings>): HostSettings {
  const current = getHostSettings();
  const next: HostSettings = {
    ...current,
    ...updates
  };

  try {
    const filePath = getHostSettingsFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {}

  return next;
}

export async function fetchRecentGitActivity(limit = 20): Promise<any[]> {
  // First attempt: query host runner daemon via GET /git-ops/logs
  try {
    const secret = process.env.HOST_RUNNER_SHARED_SECRET || "";
    const res = await fetch(`${getHostRunnerBaseUrl()}/git-ops/logs?limit=${limit}`, {
      method: "GET",
      headers: {
        "X-Host-Runner-Secret": secret
      },
      signal: AbortSignal.timeout(1500)
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.logs)) {
        return data.logs;
      }
    }
  } catch {}

  // Fallback: direct read from local disk
  const paths = [
    "C:\\AI\\ai-control\\logs\\git-ops.jsonl",
    path.resolve(process.cwd(), "logs", "git-ops.jsonl")
  ];

  for (const p of paths) {
    if (fs.existsSync(p)) {
      try {
        const lines = fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
        const slice = lines.slice(-limit);
        return slice.map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { raw: l };
          }
        });
      } catch {}
    }
  }

  return [];
}

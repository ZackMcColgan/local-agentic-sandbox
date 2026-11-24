import fs from "fs";
import path from "path";
import { resolveSettingsDir } from "./notifications";
import { getHostRunnerBaseUrl } from "./hostMode";

export interface HostSettings {
  hostAccessEnabled: boolean;
  allowUnattendedHostGit: boolean;
  jobChunkingEnabled: boolean;
  /** Board #132 opt-in host file-folder restriction. Default OFF - never a mandate. */
  fileRestrictionEnabled: boolean;
  /** Owner-entered allowed folders; sanitized (trimmed, deduped, blanks dropped). */
  allowedHostPaths: string[];
}

function sanitizeAllowedHostPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function defaultHostSettings(): HostSettings {
  return {
    hostAccessEnabled: true,
    allowUnattendedHostGit: false,
    jobChunkingEnabled: true,
    fileRestrictionEnabled: false,
    allowedHostPaths: [],
  };
}

function cloneHostSettings(settings: HostSettings): HostSettings {
  return {
    ...settings,
    allowedHostPaths: [...settings.allowedHostPaths],
  };
}

interface HostSettingsCacheEntry {
  filePath: string;
  mtimeMs: number;
  size: number;
  settings: HostSettings;
}

let hostSettingsCache: HostSettingsCacheEntry | null = null;

export function resetHostSettingsCache(): void {
  hostSettingsCache = null;
}

export function getHostSettingsFilePath(): string {
  const dir = resolveSettingsDir();
  return path.join(dir, "host-settings.json");
}

export function getHostSettings(): HostSettings {
  try {
    const resolvedPath = path.resolve(getHostSettingsFilePath());
    const stat = fs.statSync(resolvedPath);
    if (
      hostSettingsCache &&
      hostSettingsCache.filePath === resolvedPath &&
      hostSettingsCache.mtimeMs === stat.mtimeMs &&
      hostSettingsCache.size === stat.size
    ) {
      return cloneHostSettings(hostSettingsCache.settings);
    }
    const data = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
    const parsed: HostSettings = {
      hostAccessEnabled:
        typeof data?.hostAccessEnabled === "boolean" ? data.hostAccessEnabled : true,
      allowUnattendedHostGit: Boolean(data?.allowUnattendedHostGit),
      jobChunkingEnabled:
        typeof data?.jobChunkingEnabled === "boolean" ? data.jobChunkingEnabled : true,
      fileRestrictionEnabled: Boolean(data?.fileRestrictionEnabled),
      allowedHostPaths: sanitizeAllowedHostPaths(data?.allowedHostPaths),
    };
    hostSettingsCache = {
      filePath: resolvedPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      settings: parsed,
    };
    return cloneHostSettings(parsed);
  } catch {
    hostSettingsCache = null;
  }

  return defaultHostSettings();
}

export function setHostSettings(updates: Partial<HostSettings>): HostSettings {
  const current = getHostSettings();
  const next: HostSettings = {
    ...current,
    ...updates,
  };
  if (updates.allowedHostPaths !== undefined) {
    next.allowedHostPaths = sanitizeAllowedHostPaths(updates.allowedHostPaths);
  }

  try {
    const filePath = getHostSettingsFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {}

  resetHostSettingsCache();
  return next;
}

export async function fetchRecentGitActivity(limit = 20): Promise<Record<string, unknown>[]> {
  // First attempt: query host runner daemon via GET /git-ops/logs
  try {
    const secret = process.env.HOST_RUNNER_SHARED_SECRET || "";
    const res = await fetch(`${getHostRunnerBaseUrl()}/git-ops/logs?limit=${limit}`, {
      method: "GET",
      headers: {
        "X-Host-Runner-Secret": secret,
      },
      signal: AbortSignal.timeout(1500),
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
    path.resolve(process.cwd(), "logs", "git-ops.jsonl"),
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

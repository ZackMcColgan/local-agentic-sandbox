import fs from "fs";
import path from "path";
import os from "os";

export interface ProfileHistoryItem {
  value: any;
  timestamp: string;
  sourceSessionId: string;
  origin: "user-stated" | "observed" | "corrected";
}

export interface ProfileEntry {
  key: string;
  value: any;
  sourceSessionId: string;
  timestamp: string; // ISO-8601
  origin: "user-stated" | "observed" | "corrected";
  history: ProfileHistoryItem[];
}

export interface UserProfile {
  version: number;
  entries: Record<string, ProfileEntry>;
  updatedAt: string;
  [key: string]: any; // tolerant to unknown fields additively
}

/**
 * Resolves the location of user_profile.json.
 * Uses USER_PROFILE_PATH environment variable if set,
 * otherwise defaults to ~/.local-agentic-sandbox/user_profile.json.
 */
export function getUserProfilePath(): string {
  if (process.env.USER_PROFILE_PATH) {
    return path.resolve(process.env.USER_PROFILE_PATH);
  }
  const home = os.homedir() || process.env.USERPROFILE || process.env.HOME || ".";
  return path.join(home, ".local-agentic-sandbox", "user_profile.json");
}

/**
 * Loads the user profile from disk.
 * In case of missing file, returns a clean empty profile.
 * In case of JSON corruption or read failure, logs a warning and returns
 * a clean empty profile without crashing or throwing.
 */
export function loadUserProfile(customPath?: string): UserProfile {
  const filePath = customPath || getUserProfilePath();
  const emptyProfile: UserProfile = {
    version: 1,
    entries: {},
    updatedAt: new Date().toISOString()
  };

  if (!fs.existsSync(filePath)) {
    return emptyProfile;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) {
      return emptyProfile;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`[UserProfile] Warning: corrupted profile JSON structure at ${filePath}. Starting with empty profile.`);
      return emptyProfile;
    }

    return {
      version: typeof parsed.version === "number" ? parsed.version : 1,
      entries: parsed.entries && typeof parsed.entries === "object" && !Array.isArray(parsed.entries) ? parsed.entries : {},
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      ...parsed
    };
  } catch (err: any) {
    console.warn(`[UserProfile] Warning: corrupted profile JSON at ${filePath} (${err.message}). Starting with empty profile.`);
    return emptyProfile;
  }
}

/**
 * Atomically writes the user profile to disk using a temporary file and rename.
 */
export function saveUserProfile(profile: UserProfile, customPath?: string): void {
  const filePath = customPath || getUserProfilePath();
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const payload = JSON.stringify(profile, null, 2);
  const tempPath = path.join(
    dir,
    `.profile.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );

  try {
    fs.writeFileSync(tempPath, payload, "utf8");
    try {
      fs.renameSync(tempPath, filePath);
    } catch (renameErr) {
      // Fallback for Windows cross-device or file locking: copy and delete
      fs.copyFileSync(tempPath, filePath);
      fs.unlinkSync(tempPath);
    }
  } catch (err: any) {
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (_) {}
    }
    throw new Error(`[UserProfile] Failed to write profile to ${filePath}: ${err.message}`);
  }
}

/**
 * Gated record function for explicit user-stated facts, durable preferences,
 * decisions, and corrections.
 * - Supersedes existing values while preserving historical changes in `history`.
 * - Rejects pure chatter or non-durable queries when processed upstream.
 */
export function recordProfileEntry(
  key: string,
  value: any,
  options: {
    sessionId: string;
    origin?: "user-stated" | "observed" | "corrected";
    timestamp?: string;
  },
  customPath?: string
): { entry: ProfileEntry; created: boolean; updated: boolean } {
  if (!key || typeof key !== "string" || !key.trim()) {
    throw new Error("[UserProfile] Entry key must be a non-empty string");
  }

  const normalizedKey = key.trim();
  const profile = loadUserProfile(customPath);
  const now = options.timestamp || new Date().toISOString();
  const existing = profile.entries[normalizedKey];

  if (existing) {
    // If value has not changed, do not mutate history
    if (JSON.stringify(existing.value) === JSON.stringify(value)) {
      return { entry: existing, created: false, updated: false };
    }

    const historyItem: ProfileHistoryItem = {
      value: existing.value,
      timestamp: existing.timestamp,
      sourceSessionId: existing.sourceSessionId,
      origin: existing.origin
    };

    const updatedEntry: ProfileEntry = {
      key: normalizedKey,
      value,
      sourceSessionId: options.sessionId,
      timestamp: now,
      origin: options.origin || "corrected",
      history: [...(existing.history || []), historyItem]
    };

    profile.entries[normalizedKey] = updatedEntry;
    profile.updatedAt = now;
    saveUserProfile(profile, customPath);
    return { entry: updatedEntry, created: false, updated: true };
  }

  const newEntry: ProfileEntry = {
    key: normalizedKey,
    value,
    sourceSessionId: options.sessionId,
    timestamp: now,
    origin: options.origin || "user-stated",
    history: []
  };

  profile.entries[normalizedKey] = newEntry;
  profile.updatedAt = now;
  saveUserProfile(profile, customPath);
  return { entry: newEntry, created: true, updated: false };
}

/**
 * Gated rule-based extractor: extracts durable preferences or personal facts
 * strictly when explicitly stated by the user.
 * Returns empty array for chatter, jokes, weather, or generic queries.
 */
export function extractDurablePreferences(
  text: string,
  sessionId: string
): Array<{ key: string; value: any; origin: "user-stated" | "corrected" }> {
  if (!text || typeof text !== "string") {
    return [];
  }

  const clean = text.trim();
  const results: Array<{ key: string; value: any; origin: "user-stated" | "corrected" }> = [];

  // 1. Explicit name preferences: "only call me Zack", "call me Zack", "my name is Zack", "I go by Zack"
  const nameMatch = clean.match(/(?:only\s+call\s+me|please\s+call\s+me|call\s+me|my\s+name\s+is|i\s+go\s+by)\s+([A-Z][a-zA-Z0-9_\-\.]+)/i);
  if (nameMatch && nameMatch[1]) {
    const rawName = nameMatch[1].replace(/[.,!?;:]+$/, "").trim();
    if (rawName && !["a", "an", "the", "it", "bot", "assistant", "ai"].includes(rawName.toLowerCase())) {
      const isCorrection = /actually|correction|change\s+my\s+name/i.test(clean);
      results.push({
        key: "preferred_name",
        value: rawName,
        origin: isCorrection ? "corrected" : "user-stated"
      });
    }
  }

  // 2. Explicit durable programming language / tool preferences
  const langMatch = clean.match(/(?:always|prefer|please)\s+(?:use|write\s+code\s+in)\s+(typescript|javascript|python|rust|go|golang|c\+\+|java)/i);
  if (langMatch && langMatch[1]) {
    const lang = langMatch[1].toLowerCase();
    results.push({
      key: "preferred_language",
      value: lang === "golang" ? "go" : lang,
      origin: /correction|instead/i.test(clean) ? "corrected" : "user-stated"
    });
  }

  // 3. Explicit timezone or formatting preferences
  const tzMatch = clean.match(/(?:my\s+timezone\s+is|i\s+am\s+in\s+timezone)\s+([A-Za-z0-9_\-\/]+)/i);
  if (tzMatch && tzMatch[1]) {
    results.push({
      key: "timezone",
      value: tzMatch[1].trim(),
      origin: "user-stated"
    });
  }

  return results;
}

/**
 * Injects user profile preferences into working prompt context.
 * Empty if no durable facts are stored.
 */
export function formatProfileForContext(profile: UserProfile): string {
  const entries = Object.values(profile.entries || {});
  if (entries.length === 0) {
    return "";
  }

  const lines = [
    "\n--- USER PROFILE & DURABLE PREFERENCES ---",
    "Adhere to the following user preferences and verified facts:"
  ];

  for (const entry of entries) {
    if (entry.key === "preferred_name") {
      lines.push(`- Always address the user as '${entry.value}' (User stated).`);
    } else {
      lines.push(`- ${entry.key}: ${typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value)}`);
    }
  }

  lines.push("--- END USER PROFILE ---\n");
  return lines.join("\n");
}

import fs from "fs";
import path from "path";
import { resolveSettingsDir } from "../notifications";

/**
 * Owner-editable standing-facts store ("Settings Memory").
 *
 * Runtime state on the PVC only — the same class as thread records and
 * host-settings.json. It is deliberately NOT repo-tracked: the repository is
 * public and memory content holds private facts (absolute host paths, personal
 * details). The .gitignore pattern plus the repoHygiene tracked-file guard make
 * it impossible by construction for this file to enter git.
 */

export interface OperatorMemory {
  text: string;
  updatedAt: string;
}

/** Hard cap enforced server-side on save (~500 tokens). Never silently truncated. */
export const OPERATOR_MEMORY_MAX_CHARS = 2000;

/** Exact injection header used in the chat system message. */
export const OWNER_MEMORY_HEADER =
  "OWNER MEMORY (standing facts — trust these over rediscovery):";

/**
 * Resolves the location of operator-memory.json.
 * Uses OPERATOR_MEMORY_PATH environment variable if set, otherwise defaults
 * to the runtime settings dir (.agent/settings/operator-memory.json).
 */
export function getOperatorMemoryPath(): string {
  if (process.env.OPERATOR_MEMORY_PATH) {
    return path.resolve(process.env.OPERATOR_MEMORY_PATH);
  }
  return path.join(resolveSettingsDir(), "operator-memory.json");
}

/**
 * Loads operator memory from disk.
 * Missing file, empty file, corrupted JSON, or non-object JSON all load as
 * empty memory — never a crash (mirrors profile.ts tolerance).
 */
export function loadOperatorMemory(customPath?: string): OperatorMemory {
  const filePath = customPath || getOperatorMemoryPath();
  const emptyMemory: OperatorMemory = { text: "", updatedAt: new Date().toISOString() };

  if (!fs.existsSync(filePath)) {
    return emptyMemory;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) {
      return emptyMemory;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`[OperatorMemory] Warning: corrupted memory JSON structure at ${filePath}. Starting with empty memory.`);
      return emptyMemory;
    }
    return {
      text: typeof parsed.text === "string" ? parsed.text : "",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString()
    };
  } catch (err: any) {
    console.warn(`[OperatorMemory] Warning: corrupted memory JSON at ${filePath} (${err.message}). Starting with empty memory.`);
    return emptyMemory;
  }
}

/**
 * Saves operator memory with a server-side hard cap. Rejects text longer than
 * OPERATOR_MEMORY_MAX_CHARS with a clear error naming the cap; a rejected save
 * writes nothing. Atomically writes via temp file + rename (Windows fallback
 * copy+delete, same as profile.ts).
 */
export function saveOperatorMemory(text: string, customPath?: string): OperatorMemory {
  if (typeof text !== "string") {
    throw new Error("[OperatorMemory] text must be a string");
  }
  if (text.length > OPERATOR_MEMORY_MAX_CHARS) {
    throw new Error(
      `[OperatorMemory] Memory text exceeds the ${OPERATOR_MEMORY_MAX_CHARS}-character cap (${text.length} characters). Shorten it before saving.`
    );
  }

  const filePath = customPath || getOperatorMemoryPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const updatedAt = new Date().toISOString();
  const payload = JSON.stringify({ text, updatedAt }, null, 2);
  const tempPath = path.join(
    dir,
    `.operator-memory.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );

  try {
    fs.writeFileSync(tempPath, payload, "utf8");
    try {
      fs.renameSync(tempPath, filePath);
    } catch (renameErr) {
      fs.copyFileSync(tempPath, filePath);
      fs.unlinkSync(tempPath);
    }
  } catch (err: any) {
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (_) {}
    }
    throw new Error(`[OperatorMemory] Failed to write memory to ${filePath}: ${err.message}`);
  }

  return { text, updatedAt };
}

/**
 * Formats memory text for prompt injection. Empty or whitespace-only memory
 * returns "" so the assembled system prompt stays byte-identical to the legacy
 * assembly (additive, no-op default).
 */
export function formatMemoryForContext(text: string): string {
  const trimmed = (text || "").trim();
  if (!trimmed) {
    return "";
  }
  return `\n\n${OWNER_MEMORY_HEADER}\n${trimmed}`;
}

/**
 * Assembles the chat system message. Memory is inserted immediately after
 * profileContext and before the effort directive. With empty memory the result
 * is byte-identical to SYSTEM_PROMPT + profileContext + effortDirective +
 * hostDirective.
 */
export function assembleSystemPrompt(
  systemPrompt: string,
  profileContext: string,
  memoryText: string,
  effortDirective: string,
  hostDirective: string
): string {
  return systemPrompt + profileContext + formatMemoryForContext(memoryText) + effortDirective + hostDirective;
}

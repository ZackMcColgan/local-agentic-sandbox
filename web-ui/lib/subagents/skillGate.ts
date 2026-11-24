import fs from "fs";
import path from "path";
import os from "os";
import { assertValidSafeId, confinePathToRoot, isValidSafeId } from "../securityHardening";
import { atomicWriteFileSync, quarantineCorruptFile } from "../fsAtomic";

export interface SkillCandidate {
  id: string;
  title: string;
  pattern: string;
  occurrences: number;
  firstObserved: string;
  lastObserved: string;
  solutionSummary: string;
  status: "pending" | "approved" | "rejected";
  approvedAt?: string;
  rejectedAt?: string;
}

export interface SkillGateStore {
  version: number;
  candidates: Record<string, SkillCandidate>;
  updatedAt: string;
}

export function getSkillsBasePath(customPath?: string): string {
  if (customPath) return customPath;

  const preferred = process.env.SKILLS_DIR
    ? path.resolve(process.env.SKILLS_DIR)
    : path.resolve(process.cwd(), "../workspace/.agent/skills");

  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    const fallback = path.join(os.tmpdir(), "local-agentic-sandbox-skills");
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

export function getPendingQueuePath(skillsDir?: string): string {
  const dir = getSkillsBasePath(skillsDir);
  return path.join(dir, "pending.json");
}

export function loadPendingQueue(skillsDir?: string): SkillGateStore {
  const filePath = getPendingQueuePath(skillsDir);
  if (!fs.existsSync(filePath)) {
    return { version: 1, candidates: {}, updatedAt: new Date().toISOString() };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    quarantineCorruptFile(filePath, err instanceof Error ? err.message : "corrupt pending.json");
    return { version: 1, candidates: {}, updatedAt: new Date().toISOString() };
  }
}

export function savePendingQueue(store: SkillGateStore, skillsDir?: string): void {
  const filePath = getPendingQueuePath(skillsDir);
  atomicWriteFileSync(filePath, JSON.stringify(store, null, 2), 0o660);
}

/**
 * Records an observed correction or solution pattern.
 * GATED: Only enters the pending candidate queue when observed >= 3 times.
 * NEVER auto-promotes to active skills (.md files).
 */
export function recordObservedPattern(
  patternKey: string,
  details: { title: string; solutionSummary: string },
  options: { skillsDir?: string; minOccurrences?: number } = {}
): { candidate: SkillCandidate; isPendingApproval: boolean; promoted: false } {
  assertValidSafeId(patternKey, "skill candidate ID");
  const minOccurrences = options.minOccurrences ?? 3;
  const store = loadPendingQueue(options.skillsDir);
  const now = new Date().toISOString();

  let candidate = store.candidates[patternKey];
  if (!candidate) {
    candidate = {
      id: patternKey,
      title: details.title,
      pattern: patternKey,
      occurrences: 1,
      firstObserved: now,
      lastObserved: now,
      solutionSummary: details.solutionSummary,
      status: "pending",
    };
  } else {
    candidate.occurrences += 1;
    candidate.lastObserved = now;
    candidate.solutionSummary = details.solutionSummary || candidate.solutionSummary;
  }

  store.candidates[patternKey] = candidate;
  store.updatedAt = now;
  savePendingQueue(store, options.skillsDir);

  const isPendingApproval =
    candidate.occurrences >= minOccurrences && candidate.status === "pending";

  return {
    candidate,
    isPendingApproval,
    promoted: false, // NEVER auto-promotes
  };
}

/**
 * Explicit user-gated approval to promote a candidate into an active skill file (.md).
 */
export function approveSkillCandidate(
  candidateId: string,
  options: { skillsDir?: string } = {}
): { promoted: boolean; skillPath?: string; error?: string } {
  if (!isValidSafeId(candidateId)) {
    return { promoted: false, error: `Invalid skill candidate ID '${String(candidateId)}'.` };
  }
  const store = loadPendingQueue(options.skillsDir);
  const candidate = store.candidates[candidateId];

  if (!candidate) {
    return { promoted: false, error: `Candidate '${candidateId}' not found in pending queue.` };
  }
  if (!isValidSafeId(candidate.id)) {
    return { promoted: false, error: `Invalid skill candidate ID '${String(candidate.id)}'.` };
  }

  const dir = getSkillsBasePath(options.skillsDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const safeName = candidate.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const filename = `skill-${candidate.id}-${safeName}.md`;
  const skillPath = confinePathToRoot(dir, filename);

  const skillContent = `---
name: "${candidate.title}"
id: "${candidate.id}"
pattern: "${candidate.pattern}"
occurrences: ${candidate.occurrences}
approvedAt: "${new Date().toISOString()}"
---

# ${candidate.title}

## Pattern Description
${candidate.pattern}

## Approved Solution
${candidate.solutionSummary}
`;

  atomicWriteFileSync(skillPath, skillContent, 0o660);

  candidate.status = "approved";
  candidate.approvedAt = new Date().toISOString();
  store.updatedAt = new Date().toISOString();
  savePendingQueue(store, options.skillsDir);

  return {
    promoted: true,
    skillPath,
  };
}

/**
 * Rejects a skill candidate from the pending queue.
 */
export function rejectSkillCandidate(
  candidateId: string,
  options: { skillsDir?: string } = {}
): { rejected: boolean; error?: string } {
  if (!isValidSafeId(candidateId)) {
    return { rejected: false, error: `Invalid skill candidate ID '${String(candidateId)}'.` };
  }
  const store = loadPendingQueue(options.skillsDir);
  const candidate = store.candidates[candidateId];

  if (!candidate) {
    return { rejected: false, error: `Candidate '${candidateId}' not found in pending queue.` };
  }

  candidate.status = "rejected";
  candidate.rejectedAt = new Date().toISOString();
  store.updatedAt = new Date().toISOString();
  savePendingQueue(store, options.skillsDir);

  return { rejected: true };
}

/**
 * Lists all active (approved) skills in the skills directory.
 */
export function listActiveSkills(skillsDir?: string): string[] {
  const dir = getSkillsBasePath(skillsDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith("skill-") && f.endsWith(".md"));
}

/**
 * Reads a candidate's SKILL.md markdown from disk when present, falling back to
 * formatting the persisted candidate metadata without fabricated fields.
 */
export function readCandidateSkillMarkdown(
  candidate: SkillCandidate,
  skillsDir?: string
): { markdown: string; filePath: string; fromDisk: boolean } {
  const dir = getSkillsBasePath(skillsDir);
  const safeId = /^[A-Za-z0-9._-]+$/.test(candidate.id) ? candidate.id : "";
  const safeName = (candidate.title || candidate.id).toLowerCase().replace(/[^a-z0-9]+/g, "-");

  if (safeId) {
    const candidates: Array<{ abs: string; rel: string }> = [
      {
        abs: path.join(dir, "pending", `${safeId}.md`),
        rel: `skills/pending/${safeId}.md`,
      },
      {
        abs: path.join(dir, "pending", safeId, "SKILL.md"),
        rel: `skills/pending/${safeId}/SKILL.md`,
      },
      {
        abs: path.join(dir, safeId, "SKILL.md"),
        rel: `skills/${safeId}/SKILL.md`,
      },
      {
        abs: path.join(dir, `${safeId}.md`),
        rel: `skills/${safeId}.md`,
      },
      {
        abs: path.join(dir, `skill-${safeId}-${safeName}.md`),
        rel: `skills/skill-${safeId}-${safeName}.md`,
      },
    ];

    for (const entry of candidates) {
      try {
        if (fs.existsSync(entry.abs) && fs.statSync(entry.abs).isFile()) {
          return {
            markdown: fs.readFileSync(entry.abs, "utf8"),
            filePath: entry.rel,
            fromDisk: true,
          };
        }
      } catch {
        // Ignore unreadable candidate file and check next location
      }
    }
  }

  const fallbackMarkdown = `---
id: ${candidate.id}
status: ${candidate.status || "pending"}
pattern: ${candidate.pattern}
occurrences: ${candidate.occurrences}
---

## Directive
${candidate.solutionSummary}`;

  return {
    markdown: fallbackMarkdown,
    filePath: `skills/pending/${candidate.id || "candidate"}.md`,
    fromDisk: false,
  };
}

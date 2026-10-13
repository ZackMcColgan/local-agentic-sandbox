import fs from "fs";
import path from "path";
import os from "os";
import { createRequire } from "module";
import { TaskManifest } from "../subagents/types";

const requireModule = createRequire(import.meta.url);

export interface SkillPattern {
  skillId: string;
  name: string;
  description: string;
  domain: string;
  patternTemplate: string;
  sourceTaskId: string;
  confidenceScore: number;
  createdAt: string;
  useCount: number;
}

interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

function openSqliteDatabase(dbPath: string): SqliteDatabase {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const { DatabaseSync } = requireModule("node:sqlite") as {
    DatabaseSync: new (filename: string) => SqliteDatabase;
  };
  return new DatabaseSync(dbPath);
}

export function getDefaultSkillsDbPath(): string {
  if (process.env.RUN_LEDGER_DB_PATH) {
    return process.env.RUN_LEDGER_DB_PATH;
  }
  return path.join(os.homedir(), ".local-agentic-sandbox", "runs.db");
}

export class FlywheelSkillsStore {
  private db: SqliteDatabase;
  private dbPath: string;
  private isClosed = false;

  constructor(dbPath: string = getDefaultSkillsDbPath()) {
    this.dbPath = dbPath;
    this.db = openSqliteDatabase(this.dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        skill_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        domain TEXT NOT NULL,
        pattern_template TEXT NOT NULL,
        source_task_id TEXT NOT NULL,
        confidence_score REAL NOT NULL,
        created_at TEXT NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_skills_domain ON skills(domain);
      CREATE INDEX IF NOT EXISTS idx_skills_source_task ON skills(source_task_id);
    `);
  }

  public saveSkills(skills: SkillPattern[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO skills (
        skill_id, name, description, domain, pattern_template,
        source_task_id, confidence_score, created_at, use_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(skill_id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        domain = excluded.domain,
        pattern_template = excluded.pattern_template,
        confidence_score = excluded.confidence_score,
        use_count = skills.use_count + 1
    `);

    for (const s of skills) {
      stmt.run(
        s.skillId,
        s.name,
        s.description,
        s.domain,
        s.patternTemplate,
        s.sourceTaskId,
        s.confidenceScore,
        s.createdAt,
        s.useCount ?? 0
      );
    }
  }

  public listSkills(domain?: string): SkillPattern[] {
    if (domain) {
      const stmt = this.db.prepare("SELECT * FROM skills WHERE domain = ? ORDER BY use_count DESC");
      return stmt.all(domain).map((r) => this.rowToSkill(r));
    }
    const stmt = this.db.prepare("SELECT * FROM skills ORDER BY use_count DESC");
    return stmt.all().map((r) => this.rowToSkill(r));
  }

  public retrieveRelevantSkills(goal: string, limit: number = 3): SkillPattern[] {
    const all = this.listSkills();
    if (all.length === 0) return [];

    const lowerGoal = goal.toLowerCase();
    const goalTokens = lowerGoal
      .split(/[^a-z0-9_-]+/)
      .filter((t) => t.length > 2);

    const scored = all.map((skill) => {
      let score = 0;
      const lowerDomain = skill.domain.toLowerCase();
      const lowerName = skill.name.toLowerCase();
      const lowerDesc = skill.description.toLowerCase();

      // Strong domain match
      if (lowerGoal.includes(lowerDomain)) {
        score += 10;
      }

      // Keyword token matches
      for (const token of goalTokens) {
        if (lowerDomain.includes(token)) score += 5;
        if (lowerName.includes(token)) score += 3;
        if (lowerDesc.includes(token)) score += 1;
      }

      score = score * (skill.confidenceScore || 0.8) + (skill.useCount || 0) * 0.1;
      return { skill, score };
    });

    return scored
      .filter((item) => item.score > 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.skill);
  }

  private rowToSkill(row: Record<string, unknown>): SkillPattern {
    return {
      skillId: String(row.skill_id),
      name: String(row.name),
      description: String(row.description),
      domain: String(row.domain),
      patternTemplate: String(row.pattern_template),
      sourceTaskId: String(row.source_task_id),
      confidenceScore: Number(row.confidence_score),
      createdAt: String(row.created_at),
      useCount: Number(row.use_count || 0)
    };
  }

  public close(): void {
    if (!this.isClosed) {
      this.isClosed = true;
      this.db.close();
    }
  }
}

export function extractSkillsFromCompletedTask(task: TaskManifest): SkillPattern[] {
  const extracted: SkillPattern[] = [];
  const nowIso = new Date().toISOString();

  for (const m of task.milestones || []) {
    if (m.status !== "completed") continue;

    // 1. SVG Pattern extraction
    const hasSvgFile = m.plannedFiles?.some((f) => f.toLowerCase().endsWith(".svg"));
    const hasSvgDiff = m.diffSummary?.includes("<svg");
    if (hasSvgFile || hasSvgDiff) {
      extracted.push({
        skillId: `skill-svg-${task.taskId}-${m.id}`,
        name: `SVG Vector Card (${m.title})`,
        description: `Standalone vector card pattern with viewBox coordinates and background styling`,
        domain: "svg",
        patternTemplate: m.diffSummary?.slice(0, 500) || `<svg viewBox="0 0 800 600" xmlns="http://www.w3.org/2000/svg">\n  <rect width="800" height="600" rx="24" fill="#0f172a"/>\n</svg>`,
        sourceTaskId: task.taskId,
        confidenceScore: 0.95,
        createdAt: nowIso,
        useCount: 0
      });
    }

    // 2. Kubernetes / Deployment pattern
    if (m.title.toLowerCase().includes("deploy") || m.plannedFiles?.some((f) => f.includes("deployment") || f.includes("k8s"))) {
      extracted.push({
        skillId: `skill-k8s-${task.taskId}-${m.id}`,
        name: `Kubernetes Deployment & NodePort (${m.title})`,
        description: `Ephemeral service manifest with collision-free port allocation`,
        domain: "k8s",
        patternTemplate: `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app-ephemeral\nspec:\n  replicas: 1`,
        sourceTaskId: task.taskId,
        confidenceScore: 0.9,
        createdAt: nowIso,
        useCount: 0
      });
    }

    // 3. Test harness pattern
    if (m.testFile || m.acceptanceCriteria?.some((a) => a.command?.includes("test"))) {
      extracted.push({
        skillId: `skill-test-${task.taskId}-${m.id}`,
        name: `Test Suite Verification (${m.title})`,
        description: `Automated test harness with assertion criteria`,
        domain: "testing",
        patternTemplate: `import { describe, it } from "node:test";\nimport assert from "node:assert/strict";`,
        sourceTaskId: task.taskId,
        confidenceScore: 0.92,
        createdAt: nowIso,
        useCount: 0
      });
    }
  }

  return extracted;
}

export function formatSkillsForPlannerPrompt(skills: SkillPattern[]): string {
  if (!skills || skills.length === 0) return "";

  const formatted = skills
    .map(
      (s, idx) =>
        `### Pattern ${idx + 1}: ${s.name} [Domain: ${s.domain}]\n- Description: ${s.description}\n\`\`\`\n${s.patternTemplate.slice(0, 300)}\n\`\`\``
    )
    .join("\n\n");

  return `\n\n[REUSABLE PATTERNS FROM PAST SUCCESSFUL RUNS]:\n${formatted}\n`;
}

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getSharedRunLedger } from "../ledger/runLedger";

export interface ProjectRecord {
  project_id: string;
  name: string;
  root_path: string;
  base_branch: string;
  toolchain: string;
  allowlisted: number; // 1 = allowed, 0 = revoked
  active_task_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RegisterProjectInput {
  name: string;
  rootPath: string;
  baseBranch?: string;
  toolchain?: string;
}

const FORBIDDEN_SYSTEM_PATHS = [
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/root",
  "/usr",
  "/var",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64"
];

function isRootPath(p: string): boolean {
  const normalized = path.normalize(p).trim();
  if (normalized === "/" || normalized === "\\" || normalized === "") {
    return true;
  }
  // Windows drive root: e.g. "C:\", "C:/", "C:"
  if (/^[a-zA-Z]:[/\\]?$/i.test(normalized)) {
    return true;
  }
  return false;
}

function isSystemPath(p: string): boolean {
  const normalized = path.normalize(p).replace(/\\/g, "/");
  const lower = normalized.toLowerCase();

  for (const sysPath of FORBIDDEN_SYSTEM_PATHS) {
    if (lower === sysPath || lower.startsWith(sysPath + "/")) {
      return true;
    }
  }

  // Windows system paths
  const winDir = (process.env.SystemRoot || "C:/Windows").replace(/\\/g, "/").toLowerCase();
  if (lower === winDir || lower.startsWith(winDir + "/")) {
    return true;
  }

  const progFiles = (process.env["ProgramFiles"] || "C:/Program Files").replace(/\\/g, "/").toLowerCase();
  if (lower === progFiles || lower.startsWith(progFiles + "/")) {
    return true;
  }

  const progFilesX86 = (process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)").replace(/\\/g, "/").toLowerCase();
  if (lower === progFilesX86 || lower.startsWith(progFilesX86 + "/")) {
    return true;
  }

  return false;
}

export function validateProjectPath(rawPath: string): { valid: boolean; canonicalPath?: string; error?: string } {
  if (!rawPath || typeof rawPath !== "string" || !rawPath.trim()) {
    return { valid: false, error: "Project path cannot be empty" };
  }

  const trimmed = rawPath.trim();

  if (isRootPath(trimmed)) {
    return { valid: false, error: "Filesystem root directories cannot be registered as projects" };
  }

  if (isSystemPath(trimmed)) {
    return { valid: false, error: "System directories cannot be registered as projects" };
  }

  const resolved = path.resolve(trimmed);

  if (!fs.existsSync(resolved)) {
    return { valid: false, error: `Path does not exist: ${trimmed}` };
  }

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return { valid: false, error: `Path is not a directory: ${trimmed}` };
    }

    const canonicalPath = fs.realpathSync(resolved);

    if (isRootPath(canonicalPath)) {
      return { valid: false, error: "Resolved path is a filesystem root directory" };
    }

    if (isSystemPath(canonicalPath)) {
      return { valid: false, error: "Resolved path is a protected system directory" };
    }

    return { valid: true, canonicalPath };
  } catch (err: any) {
    return { valid: false, error: `Failed to inspect path: ${err.message}` };
  }
}

function getDb(dbOverride?: any) {
  const db = dbOverride || getSharedRunLedger().getDatabase();
  initProjectStore(db);
  return db;
}

let schemaInitialized = false;

export function initProjectStore(dbOverride?: any): void {
  const db = dbOverride || getSharedRunLedger().getDatabase();
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
  } catch {}
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT UNIQUE NOT NULL,
      base_branch TEXT NOT NULL DEFAULT 'develop',
      toolchain TEXT NOT NULL DEFAULT 'node:22',
      allowlisted INTEGER NOT NULL DEFAULT 1,
      active_task_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_tasks (
      task_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      head_sha TEXT,
      branch TEXT NOT NULL,
      thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS project_file_reviews (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_at TEXT,
      UNIQUE(task_id, file_path)
    );
  `);
  schemaInitialized = true;
}

export function registerProject(input: RegisterProjectInput, dbOverride?: any): ProjectRecord {
  const validation = validateProjectPath(input.rootPath);
  if (!validation.valid || !validation.canonicalPath) {
    throw new Error(validation.error || "Invalid project path");
  }

  const db = getDb(dbOverride);
  const canonicalPath = validation.canonicalPath;

  // Check for existing path
  const existing = db.prepare("SELECT * FROM projects WHERE root_path = ?").get(canonicalPath) as ProjectRecord | undefined;
  if (existing) {
    throw new Error(`Project root path is already registered: ${canonicalPath}`);
  }

  const now = new Date().toISOString();
  const projectId = `proj_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const name = input.name.trim();
  const baseBranch = (input.baseBranch || "develop").trim();
  const toolchain = (input.toolchain || "node:22").trim();

  db.prepare(`
    INSERT INTO projects (
      project_id, name, root_path, base_branch, toolchain, allowlisted, active_task_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?)
  `).run(projectId, name, canonicalPath, baseBranch, toolchain, now, now);

  return getProject(projectId, db)!;
}

export function getProject(projectId: string, dbOverride?: any): ProjectRecord | null {
  const db = getDb(dbOverride);
  const row = db.prepare("SELECT * FROM projects WHERE project_id = ?").get(projectId) as ProjectRecord | undefined;
  return row || null;
}

export function getProjectByPath(rootPath: string, dbOverride?: any): ProjectRecord | null {
  const validation = validateProjectPath(rootPath);
  const targetPath = validation.canonicalPath || path.resolve(rootPath);
  const db = getDb(dbOverride);
  const row = db.prepare("SELECT * FROM projects WHERE root_path = ?").get(targetPath) as ProjectRecord | undefined;
  return row || null;
}

export function listProjects(dbOverride?: any): ProjectRecord[] {
  const db = getDb(dbOverride);
  const rows = db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as ProjectRecord[];
  return rows;
}

export function toggleAllowlist(projectId: string, allowlisted?: boolean, dbOverride?: any): ProjectRecord {
  const db = getDb(dbOverride);
  const current = getProject(projectId, db);
  if (!current) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const newValue = allowlisted === undefined ? (current.allowlisted === 1 ? 0 : 1) : (allowlisted ? 1 : 0);
  const now = new Date().toISOString();

  db.prepare("UPDATE projects SET allowlisted = ?, updated_at = ? WHERE project_id = ?").run(newValue, now, projectId);
  return getProject(projectId, db)!;
}

export function setActiveTaskId(projectId: string, taskId: string | null, dbOverride?: any): void {
  const db = getDb(dbOverride);
  const now = new Date().toISOString();
  db.prepare("UPDATE projects SET active_task_id = ?, updated_at = ? WHERE project_id = ?").run(taskId, now, projectId);
}

export function deleteProject(projectId: string, dbOverride?: any): boolean {
  const db = getDb(dbOverride);
  const res = db.prepare("DELETE FROM projects WHERE project_id = ?").run(projectId);
  return res.changes > 0;
}

export function updateProject(projectId: string, updates: Partial<ProjectRecord>, dbOverride?: any): ProjectRecord {
  const db = getDb(dbOverride);
  const current = getProject(projectId, db);
  if (!current) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const name = updates.name !== undefined ? updates.name : current.name;
  const baseBranch = updates.base_branch !== undefined ? updates.base_branch : current.base_branch;
  const toolchain = updates.toolchain !== undefined ? updates.toolchain : current.toolchain;
  const allowlisted = updates.allowlisted !== undefined ? updates.allowlisted : current.allowlisted;
  const activeTaskId = updates.active_task_id !== undefined ? updates.active_task_id : current.active_task_id;
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE projects SET
      name = ?, base_branch = ?, toolchain = ?, allowlisted = ?, active_task_id = ?, updated_at = ?
    WHERE project_id = ?
  `).run(name, baseBranch, toolchain, allowlisted, activeTaskId, now, projectId);

  return getProject(projectId, db)!;
}

export interface ProjectTaskRecord {
  task_id: string;
  project_id: string;
  prompt: string;
  status: "pending" | "running" | "completed" | "failed" | "parked" | "cancelled";
  base_sha: string;
  head_sha?: string | null;
  branch: string;
  thread_id?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
}

export function createProjectTask(
  input: { projectId: string; prompt: string; baseSha: string; branch: string; threadId?: string },
  dbOverride?: any
): ProjectTaskRecord {
  const db = getDb(dbOverride);
  const project = getProject(input.projectId, db);
  if (!project) {
    throw new Error(`Project not found: ${input.projectId}`);
  }

  if (project.active_task_id) {
    throw new Error(`Project already has an active task running: ${project.active_task_id}`);
  }

  const existingActive = db
    .prepare("SELECT * FROM project_tasks WHERE project_id = ? AND status IN ('running', 'in_progress')")
    .get(input.projectId) as ProjectTaskRecord | undefined;
  if (existingActive) {
    throw new Error(`Project already has an active task running: ${existingActive.task_id}`);
  }

  const taskId = `task_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO project_tasks (
      task_id, project_id, prompt, status, base_sha, head_sha, branch, thread_id, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, 'running', ?, NULL, ?, ?, ?, ?, NULL)
  `).run(taskId, input.projectId, input.prompt.trim(), input.baseSha, input.branch, input.threadId || null, now, now);

  db.prepare("UPDATE projects SET active_task_id = ?, updated_at = ? WHERE project_id = ?").run(taskId, now, input.projectId);

  return getProjectTask(taskId, db)!;
}

export function getProjectTask(taskId: string, dbOverride?: any): ProjectTaskRecord | null {
  const db = getDb(dbOverride);
  const row = db.prepare("SELECT * FROM project_tasks WHERE task_id = ?").get(taskId) as ProjectTaskRecord | undefined;
  return row || null;
}

export function listProjectTasks(projectId: string, dbOverride?: any): ProjectTaskRecord[] {
  const db = getDb(dbOverride);
  const rows = db.prepare("SELECT * FROM project_tasks WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as ProjectTaskRecord[];
  return rows;
}

export function updateProjectTask(taskId: string, updates: Partial<ProjectTaskRecord>, dbOverride?: any): ProjectTaskRecord {
  const db = getDb(dbOverride);
  const current = getProjectTask(taskId, db);
  if (!current) {
    throw new Error(`Project task not found: ${taskId}`);
  }

  const status = updates.status !== undefined ? updates.status : current.status;
  const headSha = updates.head_sha !== undefined ? updates.head_sha : current.head_sha;
  const completedAt = updates.completed_at !== undefined ? updates.completed_at : current.completed_at;
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE project_tasks SET
      status = ?, head_sha = ?, completed_at = ?, updated_at = ?
    WHERE task_id = ?
  `).run(status, headSha, completedAt, now, taskId);

  return getProjectTask(taskId, db)!;
}

export function completeProjectTask(taskId: string, headSha: string, dbOverride?: any): ProjectTaskRecord {
  const db = getDb(dbOverride);
  const current = getProjectTask(taskId, db);
  if (!current) {
    throw new Error(`Project task not found: ${taskId}`);
  }

  const now = new Date().toISOString();
  db.prepare("UPDATE project_tasks SET status = 'completed', head_sha = ?, completed_at = ?, updated_at = ? WHERE task_id = ?").run(
    headSha,
    now,
    now,
    taskId
  );

  db.prepare("UPDATE projects SET active_task_id = NULL, updated_at = ? WHERE project_id = ? AND active_task_id = ?").run(
    now,
    current.project_id,
    taskId
  );

  return getProjectTask(taskId, db)!;
}

export function parkProjectTask(taskId: string, reason?: string, dbOverride?: any): ProjectTaskRecord {
  const db = getDb(dbOverride);
  const current = getProjectTask(taskId, db);
  if (!current) {
    throw new Error(`Project task not found: ${taskId}`);
  }

  const now = new Date().toISOString();
  db.prepare("UPDATE project_tasks SET status = 'parked', updated_at = ? WHERE task_id = ?").run(now, taskId);

  db.prepare("UPDATE projects SET active_task_id = NULL, updated_at = ? WHERE project_id = ? AND active_task_id = ?").run(
    now,
    current.project_id,
    taskId
  );

  return getProjectTask(taskId, db)!;
}

export function cancelProjectTask(taskId: string, reason?: string, dbOverride?: any): ProjectTaskRecord {
  const db = getDb(dbOverride);
  const current = getProjectTask(taskId, db);
  if (!current) {
    throw new Error(`Project task not found: ${taskId}`);
  }

  const now = new Date().toISOString();
  db.prepare("UPDATE project_tasks SET status = 'cancelled', updated_at = ? WHERE task_id = ?").run(now, taskId);

  db.prepare("UPDATE projects SET active_task_id = NULL, updated_at = ? WHERE project_id = ? AND active_task_id = ?").run(
    now,
    current.project_id,
    taskId
  );

  return getProjectTask(taskId, db)!;
}

export interface ProjectFileReviewRecord {
  id: string;
  task_id: string;
  file_path: string;
  status: "pending" | "accepted" | "reverted";
  reviewed_at?: string | null;
}

export function getFileReviews(taskId: string, dbOverride?: any): ProjectFileReviewRecord[] {
  const db = getDb(dbOverride);
  const rows = db.prepare("SELECT * FROM project_file_reviews WHERE task_id = ?").all(taskId) as ProjectFileReviewRecord[];
  return rows;
}

export function setFileReviewStatus(
  taskId: string,
  filePath: string,
  status: "pending" | "accepted" | "reverted",
  dbOverride?: any
): ProjectFileReviewRecord {
  const db = getDb(dbOverride);
  const normalizedPath = filePath.replace(/\\/g, "/");
  const existing = db
    .prepare("SELECT * FROM project_file_reviews WHERE task_id = ? AND file_path = ?")
    .get(taskId, normalizedPath) as ProjectFileReviewRecord | undefined;

  const now = new Date().toISOString();

  if (existing) {
    db.prepare("UPDATE project_file_reviews SET status = ?, reviewed_at = ? WHERE id = ?").run(status, now, existing.id);
    return db.prepare("SELECT * FROM project_file_reviews WHERE id = ?").get(existing.id) as ProjectFileReviewRecord;
  } else {
    const id = `rev_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    db.prepare(`
      INSERT INTO project_file_reviews (id, task_id, file_path, status, reviewed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, taskId, normalizedPath, status, now);
    return db.prepare("SELECT * FROM project_file_reviews WHERE id = ?").get(id) as ProjectFileReviewRecord;
  }
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { exec, execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { z } from "zod";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Determine Workspace Root: /workspace in container, or local fallback in repo root
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || (fsSync.existsSync("/workspace") ? "/workspace" : path.resolve(process.cwd(), "../workspace"));

// Helper: exec git commands using argv array (no shell interpolation) to prevent shell command injection
async function execGit(args: string[], cwd: string = WORKSPACE_DIR) {
  const baseArgs = [
    "-c", "safe.directory=*",
    "-c", "user.name=Autonomous Agent",
    "-c", "user.email=agent@local-sandbox.internal",
    ...args
  ];
  return execFileAsync("git", baseArgs, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/tmp/.gitconfig"
    }
  });
}

// Helper: Ensure workspace and git repo exist
async function ensureWorkspaceInitialized() {
  try {
    if (!fsSync.existsSync(WORKSPACE_DIR)) {
      await fs.mkdir(WORKSPACE_DIR, { recursive: true });
    }

    const gitDir = path.join(WORKSPACE_DIR, ".git");
    if (!fsSync.existsSync(gitDir)) {
      await execGit(["init", "-b", "main"], WORKSPACE_DIR);
    }

    // Ensure repo has at least one commit so HEAD is born and branches can be created
    try {
      await execGit(["rev-parse", "HEAD"], WORKSPACE_DIR);
    } catch {
      const readmePath = path.join(WORKSPACE_DIR, "README.md");
      if (!fsSync.existsSync(readmePath)) {
        await fs.writeFile(readmePath, "# Autonomous Agent Workspace\n\nPersistent workspace for code, branches, tests, and architecture diagrams.\n", "utf8");
      }
      await execGit(["add", "-A"], WORKSPACE_DIR);
      await execGit(["commit", "-m", "chore: initialize persistent agent workspace"], WORKSPACE_DIR);
    }
  } catch (err: any) {
    console.warn("[WorkspaceTools] Workspace initialization notice:", err.message);
  }
}

// Ensure safe path resolution within WORKSPACE_DIR
function resolveSafePath(userPath: string): string {
  const normalized = path.normalize(userPath).replace(/^(\/|\\)/, "");
  const resolved = path.resolve(WORKSPACE_DIR, normalized);
  const rootResolved = path.resolve(WORKSPACE_DIR);

  if (!resolved.startsWith(rootResolved)) {
    throw new Error(`Security Violation: Path traversal outside /workspace is forbidden (${userPath})`);
  }
  return resolved;
}

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".next",
  "dist",
  "build",
  ".venv",
  ".cache"
]);

// Helper: Guard against Catastrophic Backtracking (ReDoS) and excessive complexity
export function validateRegexPattern(pattern: string): { safe: boolean; reason?: string } {
  if (pattern.length > 500) {
    return {
      safe: false,
      reason: `Regex pattern length (${pattern.length}) exceeds safety limit of 500 characters.`
    };
  }

  // Detect catastrophic backtracking / nested repetition constructs:
  // e.g. (a+)+, (a*)*, ([a-zA-Z]+)*, ([0-9]+)+, (a|aa)+, (.*a){10}
  const dangerousConstructs = [
    /\([^)]*[*+]\??[^)]*\)\s*(\{[0-9]+,?[0-9]*\}|[*+])/, // (x+)+, (x*)*, ([a-z]+)*, (.*a){10}
    /\([^)]*\{[0-9]+,?[0-9]*\}[^)]*\)\s*(\{[0-9]+,?[0-9]*\}|[*+])/, // (x{1,5})+
    /\([^)]+\|[^)]+\)[*+]/,                     // (a|aa)+
    /([*+]\??)\1+/,                             // ++, **, +*
    /(\.\*|\.\+){2,}/                           // .*.*, .+.+
  ];

  for (const regex of dangerousConstructs) {
    if (regex.test(pattern)) {
      return {
        safe: false,
        reason: `Catastrophic backtracking (ReDoS) guard: pattern contains dangerous nested or overlapping quantifiers.`
      };
    }
  }

  return { safe: true };
}

export function registerWorkspaceTools(mcp: McpServer) {
  // Initialize workspace at startup
  ensureWorkspaceInitialized().catch(() => {});

  // 1. workspace_get_tree
  mcp.tool(
    "workspace_get_tree",
    "Retrieve a compact visual directory tree of /workspace (skipping node_modules, .git, etc.) providing repo structure in ~300 tokens.",
    {
      max_depth: z.number().optional().default(3).describe("Maximum directory depth to traverse (default: 3)"),
      sub_path: z.string().optional().describe("Optional subdirectory to inspect (relative to /workspace)")
    },
    async ({ max_depth = 3, sub_path }) => {
      await ensureWorkspaceInitialized();
      const targetDir = sub_path ? resolveSafePath(sub_path) : WORKSPACE_DIR;

      async function buildTree(dir: string, depth: number, prefix: string = ""): Promise<string[]> {
        if (depth > max_depth) return [];
        let lines: string[] = [];
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          const filtered = entries
            .filter((e) => !IGNORED_DIRS.has(e.name))
            .sort((a, b) => {
              if (a.isDirectory() && !b.isDirectory()) return -1;
              if (!a.isDirectory() && b.isDirectory()) return 1;
              return a.name.localeCompare(b.name);
            });

          for (let i = 0; i < filtered.length; i++) {
            const entry = filtered[i];
            const isLast = i === filtered.length - 1;
            const pointer = isLast ? "└── " : "├── ";
            const nextPrefix = prefix + (isLast ? "    " : "│   ");

            if (entry.isDirectory()) {
              lines.push(`${prefix}${pointer}${entry.name}/`);
              const subLines = await buildTree(path.join(dir, entry.name), depth + 1, nextPrefix);
              lines = lines.concat(subLines);
            } else {
              lines.push(`${prefix}${pointer}${entry.name}`);
            }
          }
        } catch (err: any) {
          lines.push(`${prefix}[Error reading directory: ${err.message}]`);
        }
        return lines;
      }

      const treeLines = await buildTree(targetDir, 1);
      const rootLabel = sub_path ? `/workspace/${sub_path}` : "/workspace";
      const treeOutput = [rootLabel, ...treeLines].join("\n");

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "SUCCESS",
            workspace_root: WORKSPACE_DIR,
            tree: treeOutput
          }, null, 2)
        }]
      };
    }
  );

  // 2. workspace_grep
  mcp.tool(
    "workspace_grep",
    "Fast regex/substring search across codebase in /workspace. Returns matching file paths and line snippets.",
    {
      pattern: z.string().describe("Regex or substring pattern to search for"),
      file_glob: z.string().optional().describe("Optional filename filter or extension (e.g. '*.ts', '*.py')")
    },
    async ({ pattern, file_glob }) => {
      await ensureWorkspaceInitialized();

      const validation = validateRegexPattern(pattern);
      if (!validation.safe) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "EXECUTION_ERROR",
              error: validation.reason
            }, null, 2)
          }]
        };
      }

      let regex: RegExp;
      try {
        regex = new RegExp(pattern, "i");
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "EXECUTION_ERROR",
              error: `Invalid regular expression syntax: ${err.message}`
            }, null, 2)
          }]
        };
      }

      const matches: Array<{ file: string; line: number; text: string }> = [];
      const MAX_MATCHES = 100;

      async function searchDir(dir: string) {
        if (matches.length >= MAX_MATCHES) return;
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            await searchDir(fullPath);
          } else if (entry.isFile()) {
            if (file_glob) {
              const ext = path.extname(entry.name);
              if (file_glob.startsWith("*") && !entry.name.endsWith(file_glob.slice(1))) {
                continue;
              }
            }

            try {
              const content = await fs.readFile(fullPath, "utf8");
              const lines = content.split(/\r?\n/);
              for (let lineNum = 0; lineNum < lines.length; lineNum++) {
                if (regex.test(lines[lineNum])) {
                  const relPath = path.relative(WORKSPACE_DIR, fullPath);
                  matches.push({
                    file: relPath.replace(/\\/g, "/"),
                    line: lineNum + 1,
                    text: lines[lineNum].trim()
                  });
                  if (matches.length >= MAX_MATCHES) break;
                }
              }
            } catch {
              // Skip binary or unreadable files
            }
          }
        }
      }

      await searchDir(WORKSPACE_DIR);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "SUCCESS",
            pattern,
            match_count: matches.length,
            matches
          }, null, 2)
        }]
      };
    }
  );

  // 3. workspace_read_file
  mcp.tool(
    "workspace_read_file",
    "Read file content with line numbers from /workspace. Rejects path traversal.",
    {
      path: z.string().describe("File path relative to /workspace"),
      start_line: z.number().optional().describe("Optional start line (1-indexed)"),
      end_line: z.number().optional().describe("Optional end line (1-indexed)")
    },
    async ({ path: filePath, start_line, end_line }) => {
      await ensureWorkspaceInitialized();

      try {
        const safePath = resolveSafePath(filePath);
        const raw = await fs.readFile(safePath, "utf8");
        const allLines = raw.split(/\r?\n/);
        const start = start_line ? Math.max(1, start_line) : 1;
        const end = end_line ? Math.min(allLines.length, end_line) : allLines.length;

        const slice = allLines.slice(start - 1, end);
        const formatted = slice
          .map((line, idx) => `${start + idx} | ${line}`)
          .join("\n");

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "SUCCESS",
              path: filePath,
              total_lines: allLines.length,
              showing_lines: `${start}-${end}`,
              content: formatted
            }, null, 2)
          }]
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "EXECUTION_ERROR",
              error: `Failed to read file ${filePath}: ${err.message}`
            }, null, 2)
          }]
        };
      }
    }
  );

  // 4. workspace_write_file
  mcp.tool(
    "workspace_write_file",
    "Atomically writes file to /workspace. Rejects path traversal. Supports code, Markdown docs, and .drawio.svg / .drawio XML.",
    {
      path: z.string().describe("File path relative to /workspace"),
      content: z.string().describe("The text content, code, or SVG/XML diagram to write"),
      create_dirs: z.boolean().optional().default(true).describe("Create parent directories if they don't exist")
    },
    async ({ path: filePath, content, create_dirs = true }) => {
      await ensureWorkspaceInitialized();

      try {
        const safePath = resolveSafePath(filePath);
        if (create_dirs) {
          const parent = path.dirname(safePath);
          await fs.mkdir(parent, { recursive: true });
        }

        await fs.writeFile(safePath, content, "utf8");

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "SUCCESS",
              path: filePath,
              bytes_written: Buffer.byteLength(content, "utf8"),
              is_diagram: filePath.endsWith(".drawio.svg") || filePath.endsWith(".drawio") || filePath.endsWith(".svg")
            }, null, 2)
          }]
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "EXECUTION_ERROR",
              error: `Failed to write file ${filePath}: ${err.message}`
            }, null, 2)
          }]
        };
      }
    }
  );

  // 5. workspace_run_command
  mcp.tool(
    "workspace_run_command",
    "Executes commands (pytest, npm test, python3, bash) inside /workspace. Returns stdout, stderr, and exit code.",
    {
      command: z.string().describe("Shell command to execute inside /workspace (e.g. 'pytest tests/', 'python3 script.py')"),
      timeout_seconds: z.number().optional().default(30).describe("Timeout limit in seconds (default: 30)")
    },
    async ({ command, timeout_seconds = 30 }) => {
      await ensureWorkspaceInitialized();
      const startTime = performance.now();

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: WORKSPACE_DIR,
          timeout: timeout_seconds * 1000,
          maxBuffer: 4 * 1024 * 1024
        });

        const durationMs = Math.round(performance.now() - startTime);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "SUCCESS",
              command,
              exit_code: 0,
              stdout: stdout.trim(),
              stderr: stderr.trim(),
              execution_time_ms: durationMs
            }, null, 2)
          }]
        };
      } catch (err: any) {
        const durationMs = Math.round(performance.now() - startTime);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "EXECUTION_ERROR",
              command,
              exit_code: err.code || 1,
              stdout: err.stdout ? err.stdout.trim() : "",
              stderr: err.stderr ? err.stderr.trim() : err.message,
              execution_time_ms: durationMs
            }, null, 2)
          }]
        };
      }
    }
  );

  // 6. git_status & git_diff
  mcp.tool(
    "git_status",
    "Inspect current git branch, uncommitted files, and colored unified diff in /workspace.",
    {
      cached: z.boolean().optional().default(false).describe("If true, show staged/cached diff")
    },
    async ({ cached = false }) => {
      await ensureWorkspaceInitialized();

      try {
        const branchRes = await execGit(["branch", "--show-current"], WORKSPACE_DIR);
        const branch = branchRes.stdout.trim() || "main";

        const statusRes = await execGit(["status", "--porcelain=v1"], WORKSPACE_DIR);
        const statusLines = statusRes.stdout.trim().split("\n").filter(Boolean);

        const diffArgs = cached ? ["diff", "--cached"] : ["diff"];
        const diffRes = await execGit(diffArgs, WORKSPACE_DIR);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "SUCCESS",
              branch,
              has_changes: statusLines.length > 0,
              modified_files: statusLines,
              diff: diffRes.stdout.trim()
            }, null, 2)
          }]
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "EXECUTION_ERROR",
              error: `git_status error: ${err.message}`
            }, null, 2)
          }]
        };
      }
    }
  );

  // 7. git_checkout_branch
  mcp.tool(
    "git_checkout_branch",
    "Create or switch to an autonomous feature/fix branch (e.g. agent/add-jwt-rotation) in /workspace.",
    {
      branch_name: z.string().describe("Target branch name (e.g. 'agent/fix-tests')"),
      create_new: z.boolean().optional().default(true).describe("Whether to create a new branch (-b)")
    },
    async ({ branch_name, create_new = true }) => {
      await ensureWorkspaceInitialized();

      try {
        const checkoutArgs = create_new ? ["checkout", "-B", branch_name] : ["checkout", branch_name];
        const res = await execGit(checkoutArgs, WORKSPACE_DIR);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "SUCCESS",
              current_branch: branch_name,
              output: (res.stdout + "\n" + res.stderr).trim()
            }, null, 2)
          }]
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "EXECUTION_ERROR",
              error: `git checkout error: ${err.message}`
            }, null, 2)
          }]
        };
      }
    }
  );

  // 8. git_commit
  mcp.tool(
    "git_commit",
    "Stage all changes and commit with semantic commit message in /workspace.",
    {
      message: z.string().describe("Semantic commit message (e.g. 'feat(auth): add jwt token refresh')")
    },
    async ({ message }) => {
      await ensureWorkspaceInitialized();

      try {
        await execGit(["add", "-A"], WORKSPACE_DIR);
        const commitRes = await execGit(["commit", "-m", message], WORKSPACE_DIR);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "SUCCESS",
              commit_message: message,
              output: commitRes.stdout.trim()
            }, null, 2)
          }]
        };
      } catch (err: any) {
        if (err.stdout?.includes("nothing to commit") || err.message?.includes("nothing to commit")) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "SUCCESS",
                commit_message: message,
                output: "nothing to commit, working tree clean"
              }, null, 2)
            }]
          };
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "EXECUTION_ERROR",
              error: `git commit error: ${err.message}`
            }, null, 2)
          }]
        };
      }
    }
  );
}

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import ts from "typescript";

export interface WorkspaceFileSymbol {
  path: string;
  exports: string[];
}

export interface WorkspaceRepoMap {
  root: string;
  files: WorkspaceFileSymbol[];
  treeSummary: string;
  length: number;
  toString(): string;
}

const IGNORED_SCAN_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  "out",
  ".cache",
  "tmp",
  "temp",
  ".gemini",
]);

export function scanWorkspaceRepoMap(
  rootDir: string,
  options?: { query?: string; maxFiles?: number }
): WorkspaceRepoMap {
  const maxFiles = options?.maxFiles ?? 500;
  const files: WorkspaceFileSymbol[] = [];
  const query = options?.query?.toLowerCase();

  function walk(currentDir: string) {
    if (files.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_SCAN_DIRS.has(entry.name)) {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".py"].includes(ext)) {
          const relPath = path.relative(rootDir, fullPath).replace(/\\/g, "/");
          let exports: string[] = [];

          try {
            const content = fs.readFileSync(fullPath, "utf8");
            if (ext === ".py") {
              const defMatches = content.match(/^(?:async\s+)?def\s+([a-zA-Z_0-9]+)/gm) || [];
              const classMatches = content.match(/^class\s+([a-zA-Z_0-9]+)/gm) || [];
              exports = [
                ...classMatches.map((c) => c.replace(/^class\s+/, "").trim()),
                ...defMatches.map((d) => d.replace(/^(?:async\s+)?def\s+/, "").trim()),
              ];
            } else {
              const sourceFile = ts.createSourceFile(
                entry.name,
                content,
                ts.ScriptTarget.Latest,
                true,
                ext === ".tsx"
                  ? ts.ScriptKind.TSX
                  : ext === ".jsx"
                    ? ts.ScriptKind.JSX
                    : ts.ScriptKind.TS
              );

              for (const stmt of sourceFile.statements) {
                const mods = (stmt as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
                const hasExport =
                  Array.isArray(mods) && mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
                if (hasExport) {
                  if (ts.isFunctionDeclaration(stmt) && stmt.name) {
                    exports.push(stmt.name.text);
                  } else if (ts.isClassDeclaration(stmt) && stmt.name) {
                    exports.push(stmt.name.text);
                  } else if (ts.isInterfaceDeclaration(stmt) && stmt.name) {
                    exports.push(stmt.name.text);
                  } else if (ts.isTypeAliasDeclaration(stmt) && stmt.name) {
                    exports.push(stmt.name.text);
                  } else if (ts.isEnumDeclaration(stmt) && stmt.name) {
                    exports.push(stmt.name.text);
                  } else if (ts.isVariableStatement(stmt)) {
                    for (const decl of stmt.declarationList.declarations) {
                      if (decl.name && ts.isIdentifier(decl.name)) {
                        exports.push(decl.name.text);
                      }
                    }
                  }
                } else if (
                  ts.isExportDeclaration(stmt) &&
                  stmt.exportClause &&
                  ts.isNamedExports(stmt.exportClause)
                ) {
                  for (const el of stmt.exportClause.elements) {
                    exports.push(el.name.text);
                  }
                }
              }
            }
          } catch {
            // best-effort symbol extraction
          }

          if (query) {
            const matchesQuery =
              relPath.toLowerCase().includes(query) ||
              exports.some((e) => e.toLowerCase().includes(query));
            if (!matchesQuery) continue;
          }

          files.push({ path: relPath, exports });
        }
      }
    }
  }

  walk(rootDir);

  const treeLines = files.map((f) => {
    return f.exports.length > 0 ? `${f.path}: ${f.exports.join(", ")}` : `${f.path}`;
  });

  const treeSummary = treeLines.join("\n");

  const repoMap: WorkspaceRepoMap = {
    root: rootDir,
    files,
    treeSummary,
    length: files.length,
    toString() {
      return treeSummary;
    },
  };

  return repoMap;
}

/**
 * Resolves the real HEAD SHA. Provenance rule: never synthesize a SHA.
 * Throws when no git repository is found. `strict` only inspects `repoRoot`.
 */
export function getResolvedGitSha(repoRoot?: string, opts?: { strict?: boolean }): string {
  const envWorkspace = process.env.WORKSPACE_DIR;
  const candidates = (
    opts?.strict
      ? [repoRoot]
      : [
          repoRoot,
          envWorkspace,
          fs.existsSync("/workspace") ? "/workspace" : undefined,
          process.cwd(),
          path.resolve(process.cwd(), ".."),
          path.resolve(process.cwd(), "../.."),
        ]
  ).filter(Boolean) as string[];

  for (const dir of candidates) {
    try {
      const top = execSync("git -c safe.directory=* rev-parse --show-toplevel", {
        cwd: dir,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      if (opts?.strict && path.resolve(top).toLowerCase() !== path.resolve(dir).toLowerCase())
        continue;
      const sha = execSync("git -c safe.directory=* rev-parse HEAD", {
        cwd: dir,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      if (/^[0-9a-f]{40}$/i.test(sha)) {
        return sha;
      }
    } catch {}
  }
  throw new Error(
    `No git repository found (searched: ${candidates.join(", ")}); refusing to fabricate a commit SHA.`
  );
}

export function createUnifiedDiff(filename: string, oldStr: string, newStr: string): string {
  const oldLines = oldStr ? oldStr.split("\n") : [];
  const newLines = newStr ? newStr.split("\n") : [];

  const diffLines: string[] = [
    `--- a/${filename}`,
    `+++ b/${filename}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];

  for (const line of oldLines) {
    if (!newLines.includes(line)) {
      diffLines.push(`-${line}`);
    }
  }
  for (const line of newLines) {
    if (!oldLines.includes(line)) {
      diffLines.push(`+${line}`);
    } else {
      diffLines.push(` ${line}`);
    }
  }

  return diffLines.join("\n") + "\n";
}

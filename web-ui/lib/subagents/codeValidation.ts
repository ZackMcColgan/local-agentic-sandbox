import path from "path";
import { execFileSync } from "child_process";
import ts from "typescript";
import type { Milestone } from "./types";

/**
 * TEST-ONLY deterministic content used exclusively under FAST_GRAPH_TEST.
 * Every result produced from here is flagged `synthetic: true`.
 */
export function synthesizeForFastGraphTest(
  milestone: Milestone,
  targetRelPath: string,
  previousContent: string,
  criticFeedback: string[],
  iteration: number
): string {
  let content = previousContent;
  if (criticFeedback.length > 0) {
    for (const fb of criticFeedback) {
      if (fb.includes("egress-mesh") && !content.includes("egress-mesh")) {
        content +=
          "\n// Network configuration: browser-mcp attached to egress-mesh\nexport const SCRAPER_NETWORK = 'egress-mesh';";
      }
      if ((fb.includes("#ffffff") || fb.includes("background")) && !content.includes("#ffffff")) {
        content += "\nexport const CANVAS_BACKGROUND = '#ffffff';";
      }
    }
    if (content === previousContent) {
      content += `\n// [synthetic] refinement iteration ${iteration}`;
    }
    return content;
  }
  return `// [synthetic FAST_GRAPH_TEST output] ${milestone.id}: ${milestone.title}\n// target: ${targetRelPath}\nexport interface ${milestone.id.replace(/[^A-Za-z0-9_]/g, "_")}TaskResult {\n  id: string;\n  status: string;\n}\n`;
}

// Helper: Guard against invalid code AST (TypeScript, JavaScript, Python) before file writes (nexus-agent pattern)
export function validateCodeAst(
  filePath: string,
  content: string
): { valid: boolean; error?: string } {
  const ext = path.extname(filePath).toLowerCase();

  // 1. TypeScript & JavaScript AST parsing via TypeScript compiler API
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    try {
      const scriptKind =
        ext === ".tsx"
          ? ts.ScriptKind.TSX
          : ext === ".jsx"
            ? ts.ScriptKind.JSX
            : ext === ".js" || ext === ".mjs" || ext === ".cjs"
              ? ts.ScriptKind.JS
              : ts.ScriptKind.TS;

      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true,
        scriptKind
      );

      const diagnostics =
        (sourceFile as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ||
        [];
      if (diagnostics.length > 0) {
        const first = diagnostics[0];
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(first.start || 0);
        const message = ts.flattenDiagnosticMessageText(first.messageText, "\n");
        return {
          valid: false,
          error: `Syntax error in ${filePath} [line ${line + 1}, col ${character + 1}]: ${message}`,
        };
      }
      return { valid: true };
    } catch (err: unknown) {
      return {
        valid: false,
        error: `AST parser failure: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 2. Python AST parsing via Python standard library ast module
  if (ext === ".py") {
    const pythonCmds = ["python3", "python"];
    for (const cmd of pythonCmds) {
      try {
        execFileSync(cmd, ["-c", "import ast, sys; ast.parse(sys.stdin.read())"], {
          input: content,
          encoding: "utf8",
          timeout: 3000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        return { valid: true };
      } catch (err: unknown) {
        const e = err as { stderr?: string; message?: string; code?: string; status?: number };
        const stderr = e.stderr ? e.stderr.trim() : e.message || "";
        if (e.code === "ENOENT" || e.status === 9009 || stderr.includes("Python was not found")) {
          continue;
        }
        return {
          valid: false,
          error: `Python SyntaxError in ${filePath}: ${stderr || "Invalid Python syntax"}`,
        };
      }
    }
    // Neither python3 nor python found - fail open for validation
    return { valid: true };
  }

  // 3. JSON validation
  if (ext === ".json") {
    try {
      JSON.parse(content);
      return { valid: true };
    } catch (err: unknown) {
      return {
        valid: false,
        error: `Invalid JSON syntax in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 4. SVG and XML validation (check basic well-formedness: starts with <svg or <?xml or <, has closing tag)
  if (ext === ".svg" || ext === ".xml" || ext === ".drawio") {
    const trimmed = content.trim();
    if (ext === ".svg" && (!trimmed.includes("<svg") || !trimmed.includes("</svg>"))) {
      return {
        valid: false,
        error: `Invalid SVG format in ${filePath}: missing <svg> root element or closing tag.`,
      };
    }
    if (
      (ext === ".xml" || ext === ".drawio") &&
      (!trimmed.startsWith("<") || !trimmed.endsWith(">"))
    ) {
      return {
        valid: false,
        error: `Invalid XML format in ${filePath}: not enclosed in XML tags.`,
      };
    }
    return { valid: true };
  }

  // 5. Other non-code files (Markdown, TXT, CSV) pass through
  return { valid: true };
}

// Guardrail 5 Helper: Normalize error signature by file + line + error type (build-loop pattern)
export function normalizeErrorSignature(filePath: string, errorText: string): string {
  const normFile = path.basename(filePath).toLowerCase();
  const lineMatch = errorText.match(/line\s*(\d+)|\((\d+):|:(\d+):/i);
  const line = lineMatch ? lineMatch[1] || lineMatch[2] || lineMatch[3] : "unknown";
  const typeMatch =
    errorText.match(/\b([A-Z][a-zA-Z]*Error)\b/) ||
    errorText.match(/(syntax error|parse error|unexpected token|identifier expected)/i);
  const errType = typeMatch ? typeMatch[1].toLowerCase().replace(/\s+/g, "_") : "syntax_error";
  return `${normFile}:${line}:${errType}`;
}

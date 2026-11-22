import fs from "fs";
import path from "path";

export const MAX_FILE_READ_BYTES = 2 * 1024 * 1024; // 2 MB per-file cap
export const MAX_MULTI_READ_CHARS = 256 * 1024; // 256 KiB aggregate cap (matches explorerFs DEFAULT_MAX_BYTES)
export const MAX_MANIFEST_ENUM_FILES = 5000;
const BINARY_SNIFF_BYTES = 8192;

export const MULTI_READ_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".venv",
  "bin",
  "obj",
  "target",
]);

export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".tif",
  ".tiff",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".tgz",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".dat",
  ".wasm",
  ".node",
  ".pyc",
  ".pyo",
  ".class",
  ".jar",
  ".o",
  ".obj",
  ".a",
  ".lib",
  ".pdb",
  ".mp3",
  ".mp4",
  ".wav",
  ".avi",
  ".mov",
  ".mkv",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".sqlite",
  ".sqlite3",
  ".db",
  ".lockb",
  ".asar",
  ".pak",
]);

export type MultiReadSkipReason =
  | "excluded_directory"
  | "binary_file"
  | "exceeds_2mb_limit"
  | "aggregate_limit_reached"
  | "aggregate_limit_truncated"
  | "enumeration_limit_reached"
  | "not_found"
  | "read_error";

export interface MultiReadFileEntry {
  path: string;
  content: string;
  total_lines: number;
  total_bytes: number;
  showing_lines: string;
  truncated: boolean;
  deduplicated?: boolean;
}

export interface MultiReadManifestEntry {
  path: string;
  status: "truncated" | "skipped";
  reason: MultiReadSkipReason;
  total_bytes?: number;
  included_chars?: number;
  detail?: string;
}

export interface MultiReadResult {
  success: true;
  multi: true;
  total_files_read: number;
  total_chars: number;
  max_total_chars: number;
  truncated: boolean;
  files: MultiReadFileEntry[];
  manifest: MultiReadManifestEntry[];
}

export interface MultiReadOptions {
  maxTotalChars?: number;
  maxFileBytes?: number;
}

/**
 * Detects binary files via known binary extensions plus an 8 KiB content sniff
 * (NUL byte check and high non-whitespace control-byte ratio).
 */
export function isBinaryFile(resolvedPath: string): boolean {
  const ext = path.extname(resolvedPath).toLowerCase();
  if (ext && BINARY_EXTENSIONS.has(ext)) {
    return true;
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(resolvedPath, "r");
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, BINARY_SNIFF_BYTES, 0);
    if (bytesRead === 0) return false;

    let controlBytes = 0;
    for (let i = 0; i < bytesRead; i++) {
      const b = buf[i];
      if (b === 0x00) {
        return true;
      }
      // Non-whitespace control characters (excluding \b, \t, \n, \f, \r, ESC)
      if (b < 0x08 || (b >= 0x0e && b <= 0x1a) || (b >= 0x1c && b <= 0x1f)) {
        controlBytes++;
      }
    }
    return controlBytes / bytesRead > 0.3;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

interface DiscoveredFile {
  displayPath: string;
  resolvedPath: string;
}

/**
 * Expands a list of file and/or directory paths recursively and reads them under
 * mandatory guardrails (excluded dirs, binary sniff, per-file 2 MB cap, and
 * bounded aggregate total with an explicit manifest for every skipped/truncated file).
 */
export function readMultipleFiles(
  rawPaths: string[],
  effectiveCwd: string,
  options: MultiReadOptions = {}
): MultiReadResult {
  const maxTotalChars = Math.max(
    1,
    Math.min(
      MAX_MULTI_READ_CHARS,
      typeof options.maxTotalChars === "number" && Number.isFinite(options.maxTotalChars)
        ? Math.floor(options.maxTotalChars)
        : MAX_MULTI_READ_CHARS
    )
  );
  const maxFileBytes =
    typeof options.maxFileBytes === "number" && options.maxFileBytes > 0
      ? options.maxFileBytes
      : MAX_FILE_READ_BYTES;

  const discovered: DiscoveredFile[] = [];
  const seenResolved = new Set<string>();
  const manifest: MultiReadManifestEntry[] = [];
  let enumCapHit = false;

  const normalizeDedupKey = (p: string): string =>
    process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);

  function walkDir(currentAbs: string, currentDisplay: string) {
    if (discovered.length >= MAX_MANIFEST_ENUM_FILES) {
      enumCapHit = true;
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentAbs, { withFileTypes: true });
    } catch (err: unknown) {
      manifest.push({
        path: currentDisplay,
        status: "skipped",
        reason: "read_error",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (discovered.length >= MAX_MANIFEST_ENUM_FILES) {
        enumCapHit = true;
        return;
      }

      const childAbs = path.join(currentAbs, entry.name);
      const childDisplay = path.join(currentDisplay, entry.name);

      if (entry.isDirectory()) {
        if (MULTI_READ_SKIP_DIRS.has(entry.name)) {
          manifest.push({
            path: childDisplay,
            status: "skipped",
            reason: "excluded_directory",
          });
          continue;
        }
        walkDir(childAbs, childDisplay);
      } else if (entry.isFile()) {
        const key = normalizeDedupKey(childAbs);
        if (!seenResolved.has(key)) {
          seenResolved.add(key);
          discovered.push({ displayPath: childDisplay, resolvedPath: childAbs });
        }
      }
    }
  }

  for (const rawEntry of rawPaths) {
    const trimmed = rawEntry.trim();
    const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(effectiveCwd, trimmed);

    if (!fs.existsSync(resolved)) {
      manifest.push({
        path: trimmed,
        status: "skipped",
        reason: "not_found",
      });
      continue;
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(resolved);
    } catch (err: unknown) {
      manifest.push({
        path: trimmed,
        status: "skipped",
        reason: "read_error",
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (stats.isDirectory()) {
      walkDir(resolved, trimmed);
    } else if (stats.isFile()) {
      const key = normalizeDedupKey(resolved);
      if (!seenResolved.has(key)) {
        seenResolved.add(key);
        discovered.push({ displayPath: trimmed, resolvedPath: resolved });
      }
    } else {
      manifest.push({
        path: trimmed,
        status: "skipped",
        reason: "read_error",
        detail: "Path is neither a regular file nor a directory",
      });
    }
  }

  if (enumCapHit) {
    manifest.push({
      path: rawPaths.join(", "),
      status: "skipped",
      reason: "enumeration_limit_reached",
      detail: `Directory expansion capped at ${MAX_MANIFEST_ENUM_FILES} files`,
    });
  }

  const files: MultiReadFileEntry[] = [];
  let totalChars = 0;
  let budgetExhausted = false;
  let anyTruncated = enumCapHit;

  for (const item of discovered) {
    let stats: fs.Stats;
    try {
      stats = fs.statSync(item.resolvedPath);
    } catch (err: unknown) {
      manifest.push({
        path: item.displayPath,
        status: "skipped",
        reason: "read_error",
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (stats.size > maxFileBytes) {
      manifest.push({
        path: item.displayPath,
        status: "skipped",
        reason: "exceeds_2mb_limit",
        total_bytes: stats.size,
      });
      continue;
    }

    if (isBinaryFile(item.resolvedPath)) {
      manifest.push({
        path: item.displayPath,
        status: "skipped",
        reason: "binary_file",
        total_bytes: stats.size,
      });
      continue;
    }

    const remaining = maxTotalChars - totalChars;
    if (budgetExhausted || remaining <= 0) {
      anyTruncated = true;
      budgetExhausted = true;
      manifest.push({
        path: item.displayPath,
        status: "skipped",
        reason: "aggregate_limit_reached",
        total_bytes: stats.size,
      });
      continue;
    }

    let rawContent: string;
    try {
      rawContent = fs.readFileSync(item.resolvedPath, "utf8");
    } catch (err: unknown) {
      manifest.push({
        path: item.displayPath,
        status: "skipped",
        reason: "read_error",
        total_bytes: stats.size,
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const allLines = rawContent.split(/\r?\n/);
    const formatted = allLines.map((line, idx) => `${idx + 1} | ${line}`).join("\n");

    if (formatted.length <= remaining) {
      files.push({
        path: item.displayPath,
        content: formatted,
        total_lines: allLines.length,
        total_bytes: stats.size,
        showing_lines: `1-${allLines.length}`,
        truncated: false,
      });
      totalChars += formatted.length;
    } else {
      anyTruncated = true;
      budgetExhausted = true;
      let sliced = formatted.slice(0, remaining);
      const lastNewline = sliced.lastIndexOf("\n");
      if (lastNewline > 0) {
        sliced = sliced.slice(0, lastNewline);
      }

      if (sliced.length > 0) {
        const shownLines = sliced.split("\n").length;
        files.push({
          path: item.displayPath,
          content: sliced,
          total_lines: allLines.length,
          total_bytes: stats.size,
          showing_lines: `1-${shownLines}`,
          truncated: true,
        });
        totalChars += sliced.length;
        manifest.push({
          path: item.displayPath,
          status: "truncated",
          reason: "aggregate_limit_truncated",
          total_bytes: stats.size,
          included_chars: sliced.length,
        });
      } else {
        manifest.push({
          path: item.displayPath,
          status: "skipped",
          reason: "aggregate_limit_reached",
          total_bytes: stats.size,
        });
      }
    }
  }

  return {
    success: true,
    multi: true,
    total_files_read: files.length,
    total_chars: totalChars,
    max_total_chars: maxTotalChars,
    truncated: anyTruncated,
    files,
    manifest,
  };
}

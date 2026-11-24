import fs from "node:fs";
import path from "node:path";

/**
 * Atomically writes `content` to `targetPath` via a same-directory temp file
 * and `fs.renameSync` (falling back to copy+unlink only if rename fails across
 * mount boundaries). Cleans up the temp file on error.
 */
export function atomicWriteFileSync(targetPath: string, content: string, mode = 0o660): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o770 });
  }
  const base = path.basename(targetPath);
  const tempPath = path.join(
    dir,
    `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );
  try {
    fs.writeFileSync(tempPath, content, { encoding: "utf8", mode });
    try {
      fs.chmodSync(tempPath, mode);
    } catch {
      // Ignore chmod errors on platforms/filesystems without POSIX mode bits
    }
    try {
      fs.renameSync(tempPath, targetPath);
    } catch {
      fs.copyFileSync(tempPath, targetPath);
      fs.unlinkSync(tempPath);
    }
    try {
      fs.chmodSync(targetPath, mode);
    } catch {
      // Ignore chmod errors on platforms/filesystems without POSIX mode bits
    }
  } catch (err) {
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Ignore cleanup failure
      }
    }
    throw err;
  }
}

import fs from "node:fs";
import path from "node:path";

/**
 * Atomically writes `content` to `targetPath` via a same-directory temp file,
 * `fsyncSync`, and `fs.renameSync` (falling back to copy+unlink only if rename
 * fails across mount boundaries). Cleans up the temp file on error.
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
    const fd = fs.openSync(tempPath, "w", mode);
    try {
      fs.writeFileSync(fd, content, "utf8");
      try {
        fs.fsyncSync(fd);
      } catch {
        // Ignore fsync errors on virtual filesystems that do not support fsync
      }
    } finally {
      fs.closeSync(fd);
    }
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

/**
 * Async variant of `atomicWriteFileSync`: writes temp file in the same directory,
 * calls `sync()` on the file handle, closes it, and renames atomically into place.
 */
export async function atomicWriteFile(
  targetPath: string,
  content: string,
  mode = 0o660
): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o770 });
  const base = path.basename(targetPath);
  const tempPath = path.join(
    dir,
    `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );
  try {
    const handle = await fs.promises.open(tempPath, "w", mode);
    try {
      await handle.writeFile(content, "utf8");
      try {
        await handle.sync();
      } catch {
        // Ignore sync errors on virtual filesystems
      }
    } finally {
      await handle.close();
    }
    try {
      await fs.promises.chmod(tempPath, mode);
    } catch {}
    try {
      await fs.promises.rename(tempPath, targetPath);
    } catch {
      await fs.promises.copyFile(tempPath, targetPath);
      await fs.promises.unlink(tempPath);
    }
    try {
      await fs.promises.chmod(targetPath, mode);
    } catch {}
  } catch (err) {
    try {
      await fs.promises.unlink(tempPath);
    } catch {}
    throw err;
  }
}

/**
 * Isolates a corrupt JSON store file by renaming it to `<filePath>.corrupt.<ts>`
 * so original bytes are preserved for inspection while the store keeps serving.
 */
export function quarantineCorruptFile(filePath: string, reason: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const quarantinePath = `${filePath}.corrupt.${Date.now()}`;
  try {
    fs.renameSync(filePath, quarantinePath);
    console.error(
      `[Durability] Quarantined corrupt file '${filePath}' -> '${quarantinePath}' (${reason})`
    );
    return quarantinePath;
  } catch (err) {
    console.error(
      `[Durability] Failed to quarantine corrupt file '${filePath}': ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

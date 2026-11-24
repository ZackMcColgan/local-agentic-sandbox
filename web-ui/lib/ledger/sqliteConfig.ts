export interface SqliteExecHandle {
  exec(sql: string): void;
}

export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/**
 * Configures a SQLite database handle for crash durability and concurrent access:
 * enables WAL journal mode (for file-backed DBs), sets busy_timeout=5000ms,
 * and uses synchronous=NORMAL.
 */
export function configureSqliteHandle(db: SqliteExecHandle, dbPath: string): void {
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
  const isMemory = dbPath === ":memory:" || dbPath.startsWith("file::memory:");
  if (!isMemory) {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }
}

/**
 * Executes a synchronous write block inside a `BEGIN IMMEDIATE` transaction so
 * concurrent writers acquire the RESERVED lock immediately and respect busy_timeout.
 */
export function runImmediateTransaction<T>(db: SqliteExecHandle, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors if transaction was already aborted
    }
    throw err;
  }
}

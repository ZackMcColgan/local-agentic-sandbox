import fs from "fs";
import path from "path";
import { MemorySaver } from "@langchain/langgraph";

function packValue(obj: unknown): unknown {
  if (obj instanceof Uint8Array || Buffer.isBuffer(obj)) {
    return { __u8: Buffer.from(obj).toString("base64") };
  }
  if (Array.isArray(obj)) {
    return obj.map(packValue);
  }
  if (obj && typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    const res: Record<string, unknown> = {};
    for (const k of Object.keys(rec)) {
      res[k] = packValue(rec[k]);
    }
    return res;
  }
  return obj;
}

function unpackValue(obj: unknown): unknown {
  if (obj && typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    if (typeof rec.__u8 === "string") {
      return new Uint8Array(Buffer.from(rec.__u8, "base64"));
    }
    if (Array.isArray(obj)) {
      return obj.map(unpackValue);
    }
    const res: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(rec)) {
      res[k] = unpackValue(rec[k]);
    }
    return res;
  }
  return obj;
}

/**
 * File-backed durable LangGraph Checkpointer
 * Extends MemorySaver with automatic thread serialization to `${threadId}-lg-checkpoint.json`
 */
export class FileCheckpointSaver extends MemorySaver {
  readonly checkpointDir: string;

  constructor(checkpointDir: string) {
    super();
    this.checkpointDir = checkpointDir;
    try {
      if (!fs.existsSync(this.checkpointDir)) {
        fs.mkdirSync(this.checkpointDir, { recursive: true });
      }
      this.loadFromDisk();
    } catch (err) {
      console.warn("Could not initialize FileCheckpointSaver on disk:", err);
    }
  }

  getFilePath(threadId: string): string {
    return path.join(this.checkpointDir, `${threadId}-lg-checkpoint.json`);
  }

  private loadFromDisk() {
    if (!fs.existsSync(this.checkpointDir)) return;
    try {
      const files = fs.readdirSync(this.checkpointDir);
      for (const file of files) {
        if (file.endsWith("-lg-checkpoint.json")) {
          const threadId = file.replace("-lg-checkpoint.json", "");
          const fullPath = path.join(this.checkpointDir, file);
          const raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));
          if (raw && raw.storage) {
            this.storage[threadId] = unpackValue(raw.storage) as (typeof this.storage)[string];
          }
          if (raw && raw.writes) {
            for (const wk of Object.keys(raw.writes)) {
              this.writes[wk] = unpackValue(raw.writes[wk]) as (typeof this.writes)[string];
            }
          }
        }
      }
    } catch (err: unknown) {
      console.error(
        `[FileCheckpointSaver] Failed to load checkpoints from disk at ${this.checkpointDir}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  private persistThreadToDisk(threadId: string) {
    if (!this.storage[threadId]) return;
    const writesForThread: Record<string, unknown> = {};
    for (const wk of Object.keys(this.writes)) {
      if (wk.includes(threadId)) {
        writesForThread[wk] = this.writes[wk];
      }
    }
    const fullPath = this.getFilePath(threadId);
    fs.writeFileSync(
      fullPath,
      JSON.stringify(
        {
          storage: packValue(this.storage[threadId]),
          writes: packValue(writesForThread),
        },
        null,
        2
      ),
      "utf8"
    );
  }

  async put(
    config: Parameters<MemorySaver["put"]>[0],
    checkpoint: Parameters<MemorySaver["put"]>[1],
    metadata: Parameters<MemorySaver["put"]>[2]
  ) {
    const res = await super.put(config, checkpoint, metadata);
    const threadId = config.configurable?.thread_id;
    if (threadId) {
      this.persistThreadToDisk(threadId);
    }
    return res;
  }

  async putWrites(
    config: Parameters<MemorySaver["putWrites"]>[0],
    writes: Parameters<MemorySaver["putWrites"]>[1],
    taskId: Parameters<MemorySaver["putWrites"]>[2]
  ) {
    const res = await super.putWrites(config, writes, taskId);
    const threadId = config.configurable?.thread_id;
    if (threadId) {
      this.persistThreadToDisk(threadId);
    }
    return res;
  }
}

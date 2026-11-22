import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHostServer } from "../../host-bridge/server";
import {
  MAX_MULTI_READ_CHARS,
  MULTI_READ_SKIP_DIRS,
  readMultipleFiles,
} from "../../host-bridge/multiRead";
import { isDestructiveHostAction } from "../../host-bridge/classifier";
import { HOST_TOOLS_DEFINITIONS } from "../lib/hostMode";
import { ReadDedupRegistry, computeContentHash, type MultiReadResultShape } from "../lib/readDedup";

const TEST_SECRET = "test-multi-read-secret-at-least-32-chars-long";

describe("Part 1: host_read_file multi-file & directory read", () => {
  let hostServer: ReturnType<typeof createHostServer>;
  let baseUrl = "";
  let port = 0;

  before(async () => {
    hostServer = createHostServer({ port: 0, sharedSecret: TEST_SECRET });
    await hostServer.start();
    const addr = hostServer.server.address() as { port: number };
    port = addr.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await hostServer.stop();
  });

  async function execHost(tool: string, args: Record<string, unknown>) {
    const res = await fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Host-Runner-Secret": TEST_SECRET,
        Host: `127.0.0.1:${port}`,
      },
      body: JSON.stringify({ tool, args }),
    });
    const data = await res.json();
    return { status: res.status, data };
  }

  it("model-facing host_read_file schema exposes optional path and paths: string[]", () => {
    const def = HOST_TOOLS_DEFINITIONS.find((t) => t.function.name === "host_read_file");
    assert.ok(def, "host_read_file must exist in HOST_TOOLS_DEFINITIONS");
    const params = def.function.parameters as unknown as {
      properties?: Record<string, { type?: string; items?: { type?: string } }>;
      required?: string[];
    };
    assert.equal(params.properties?.path?.type, "string");
    assert.equal(params.properties?.paths?.type, "array");
    assert.equal(params.properties?.paths?.items?.type, "string");
    assert.ok(
      !params.required || !params.required.includes("path"),
      "path must not be unconditionally required when paths is an alternative"
    );
  });

  it("destructive classifier treats host_read_file with paths as non-destructive", () => {
    const check = isDestructiveHostAction("host_read_file", {
      paths: ["C:\\repo\\web-ui"],
    });
    assert.equal(check.isDestructive, false);
  });

  it("rejects calls providing both path and paths, neither, or empty paths", async () => {
    const both = await execHost("host_read_file", { path: "a.ts", paths: ["b.ts"] });
    assert.equal(both.status, 200);
    assert.equal(both.data.success, false);
    assert.match(String(both.data.error), /path.*paths/i);

    const neither = await execHost("host_read_file", {});
    assert.equal(neither.status, 200);
    assert.equal(neither.data.success, false);
    assert.match(String(neither.data.error), /path.*paths/i);

    const empty = await execHost("host_read_file", { paths: [] });
    assert.equal(empty.status, 200);
    assert.equal(empty.data.success, false);
    assert.match(String(empty.data.error), /non-empty/i);
  });

  it("reads a fixture tree recursively, labels every file, and skips node_modules, .git, build outputs, binaries, and >2MB files", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multi-read-tree-"));
    try {
      // Valid nested text files
      fs.mkdirSync(path.join(tmpRoot, "src", "nested"), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, "README.md"), "# Hello\nWorld\n", "utf8");
      fs.writeFileSync(path.join(tmpRoot, "src", "alpha.ts"), "export const a = 1;\n", "utf8");
      fs.writeFileSync(
        path.join(tmpRoot, "src", "nested", "beta.ts"),
        "export const b = 2;\n",
        "utf8"
      );

      // Excluded directories that must NEVER be descended into
      fs.mkdirSync(path.join(tmpRoot, "node_modules", "pkg"), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, "node_modules", "pkg", "index.js"), "secret", "utf8");
      fs.mkdirSync(path.join(tmpRoot, ".git", "objects"), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, ".git", "HEAD"), "ref: refs/heads/main", "utf8");
      fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, "dist", "bundle.js"), "compiled", "utf8");
      fs.mkdirSync(path.join(tmpRoot, ".next"), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, ".next", "build.js"), "next-build", "utf8");

      // Binary files: one by extension, one by content sniff (NUL bytes in .txt)
      fs.writeFileSync(
        path.join(tmpRoot, "logo.png"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      );
      fs.writeFileSync(
        path.join(tmpRoot, "src", "sniffed.txt"),
        Buffer.from([0x41, 0x42, 0x00, 0x43, 0x44])
      );

      // Oversized >2MB text file
      const bigPath = path.join(tmpRoot, "huge.log");
      fs.writeFileSync(bigPath, Buffer.alloc(2 * 1024 * 1024 + 64, "x"));

      const missingPath = path.join(tmpRoot, "does-not-exist.ts");

      const { status, data } = await execHost("host_read_file", {
        paths: [tmpRoot, missingPath],
      });
      assert.equal(status, 200);
      assert.equal(data.success, true);
      assert.equal(data.multi, true);
      assert.equal(data.max_total_chars, MAX_MULTI_READ_CHARS);

      const files = data.files as Array<{ path: string; content: string; truncated: boolean }>;
      const manifest = data.manifest as Array<{
        path: string;
        status: string;
        reason?: string;
      }>;

      const returnedNames = files.map((f) => path.relative(tmpRoot, f.path).replace(/\\/g, "/"));
      assert.deepEqual(returnedNames.sort(), ["README.md", "src/alpha.ts", "src/nested/beta.ts"]);

      // Every returned file is labeled with its path and line-numbered content
      const alpha = files.find((f) => f.path.endsWith("alpha.ts"));
      assert.ok(alpha);
      assert.ok(alpha.content.includes("1 | export const a = 1;"));
      assert.equal(alpha.truncated, false);

      // Excluded dirs skipped (never descended into)
      assert.ok(
        !files.some(
          (f) =>
            f.path.includes("node_modules") ||
            f.path.includes(".git") ||
            f.path.includes("dist") ||
            f.path.includes(".next")
        ),
        "excluded directories must not appear in returned files"
      );
      for (const dirName of ["node_modules", ".git", "dist", ".next"]) {
        assert.ok(MULTI_READ_SKIP_DIRS.has(dirName));
        assert.ok(
          manifest.some(
            (m) =>
              m.status === "skipped" &&
              m.reason === "excluded_directory" &&
              path.basename(m.path) === dirName
          ),
          `manifest must record skipped directory ${dirName}`
        );
      }

      // Binaries skipped (extension + content sniff)
      assert.ok(
        manifest.some(
          (m) => m.status === "skipped" && m.reason === "binary_file" && m.path.endsWith("logo.png")
        ),
        "manifest must record extension-detected binary file"
      );
      assert.ok(
        manifest.some(
          (m) =>
            m.status === "skipped" && m.reason === "binary_file" && m.path.endsWith("sniffed.txt")
        ),
        "manifest must record content-sniffed binary file"
      );

      // >2MB file skipped without aborting siblings
      assert.ok(
        manifest.some(
          (m) =>
            m.status === "skipped" &&
            m.reason === "exceeds_2mb_limit" &&
            m.path.endsWith("huge.log")
        ),
        "manifest must record >2MB skipped file"
      );

      // Missing path recorded in manifest
      assert.ok(
        manifest.some(
          (m) => m.status === "skipped" && m.reason === "not_found" && m.path === missingPath
        ),
        "manifest must record missing path"
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("enforces aggregate bound and populates manifest for every truncated and skipped file (no silent omission)", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multi-read-bound-"));
    try {
      const f1 = path.join(tmpRoot, "01-first.txt");
      const f2 = path.join(tmpRoot, "02-second.txt");
      const f3 = path.join(tmpRoot, "03-third.txt");
      const f4 = path.join(tmpRoot, "04-fourth.txt");
      fs.writeFileSync(f1, Array.from({ length: 10 }, (_, i) => `first-line-${i}`).join("\n"));
      fs.writeFileSync(
        f2,
        Array.from({ length: 20 }, (_, i) => `second-line-${i}-${"B".repeat(20)}`).join("\n")
      );
      fs.writeFileSync(f3, Array.from({ length: 10 }, (_, i) => `third-line-${i}`).join("\n"));
      fs.writeFileSync(f4, Array.from({ length: 10 }, (_, i) => `fourth-line-${i}`).join("\n"));

      // Budget large enough for f1 + part of f2, forcing f2 truncation and f3/f4 skipping
      const bound = 350;
      const result = readMultipleFiles([tmpRoot], tmpRoot, { maxTotalChars: bound });

      assert.equal(result.success, true);
      assert.equal(result.truncated, true);
      assert.ok(
        result.total_chars <= bound,
        `total_chars (${result.total_chars}) must not exceed bound (${bound})`
      );

      // f1 full, f2 truncated, f3 & f4 skipped in manifest
      const returnedPaths = result.files.map((f) => f.path);
      assert.ok(returnedPaths.includes(f1), "f1 should be returned");
      const f2Entry = result.files.find((f) => f.path === f2);
      assert.ok(f2Entry, "f2 should be partially returned");
      assert.equal(f2Entry.truncated, true, "f2 must be marked truncated");
      assert.ok(!returnedPaths.includes(f3), "f3 must not be returned when budget exhausted");
      assert.ok(!returnedPaths.includes(f4), "f4 must not be returned when budget exhausted");

      const truncEntry = result.manifest.find((m) => m.path === f2);
      assert.equal(truncEntry?.status, "truncated");
      assert.equal(truncEntry?.reason, "aggregate_limit_truncated");

      for (const skippedPath of [f3, f4]) {
        const entry = result.manifest.find((m) => m.path === skippedPath);
        assert.ok(entry, `manifest must list skipped file ${skippedPath}`);
        assert.equal(entry.status, "skipped");
        assert.equal(entry.reason, "aggregate_limit_reached");
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("enforces default MAX_MULTI_READ_CHARS (256 KiB) aggregate ceiling over HTTP /execute", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multi-read-default-cap-"));
    try {
      // 4 files of ~100 KB each (~400 KB > 256 KiB default)
      const chunk = "A".repeat(95) + "\n";
      const fileBody = chunk.repeat(1000); // ~96 KB
      for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
        fs.writeFileSync(path.join(tmpRoot, name), fileBody, "utf8");
      }

      const { status, data } = await execHost("host_read_file", { paths: [tmpRoot] });
      assert.equal(status, 200);
      assert.equal(data.success, true);
      assert.equal(data.truncated, true);
      assert.equal(data.max_total_chars, MAX_MULTI_READ_CHARS);
      assert.ok(
        data.total_chars <= MAX_MULTI_READ_CHARS,
        `total_chars (${data.total_chars}) must be <= ${MAX_MULTI_READ_CHARS}`
      );
      assert.ok(
        (data.manifest as Array<{ path: string; status: string }>).some((m) =>
          m.path.endsWith("d.txt")
        ),
        "d.txt must be explicitly accounted for in manifest"
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("Part 1: per-file read dedup inside multi-read results", () => {
  function makeMultiResult(
    entries: Array<{ path: string; content: string; truncated?: boolean }>
  ): MultiReadResultShape {
    const files = entries.map((e) => ({
      path: e.path,
      content: e.content,
      total_lines: e.content.split("\n").length,
      total_bytes: Buffer.byteLength(e.content, "utf8"),
      showing_lines: `1-${e.content.split("\n").length}`,
      truncated: Boolean(e.truncated),
    }));
    return {
      success: true,
      multi: true,
      total_files_read: files.length,
      total_chars: files.reduce((s, f) => s + f.content.length, 0),
      max_total_chars: MAX_MULTI_READ_CHARS,
      truncated: files.some((f) => f.truncated),
      files,
      manifest: [],
    };
  }

  it("stubs ONLY the unchanged file inside a second multi-read while returning full content for a changed sibling", () => {
    const registry = new ReadDedupRegistry([]);
    const contentA = Array.from(
      { length: 20 },
      (_, i) => `${i + 1} | const alpha_${i} = "unchanged-payload-value";`
    ).join("\n");
    const contentB1 = Array.from(
      { length: 20 },
      (_, i) => `${i + 1} | const beta_${i} = "version-one-payload";`
    ).join("\n");
    const contentB2 = Array.from(
      { length: 20 },
      (_, i) => `${i + 1} | const beta_${i} = "version-two-modified";`
    ).join("\n");

    const firstRaw = makeMultiResult([
      { path: "C:\\repo\\a.ts", content: contentA },
      { path: "C:\\repo\\b.ts", content: contentB1 },
    ]);

    const firstOut = registry.checkAndRecordMultiRead("host_read_file", firstRaw, 1, 0);
    assert.equal(firstOut.dedupedMetas.length, 0, "first multi-read must not stub any file");
    assert.equal(firstOut.result.files[0].content, contentA);
    assert.equal(firstOut.result.files[1].content, contentB1);

    // Second multi-read: a.ts unchanged, b.ts changed
    const secondRaw = makeMultiResult([
      { path: "C:\\repo\\a.ts", content: contentA },
      { path: "C:\\repo\\b.ts", content: contentB2 },
    ]);

    const secondOut = registry.checkAndRecordMultiRead("host_read_file", secondRaw, 3, 5);
    assert.equal(secondOut.dedupedMetas.length, 1, "only the unchanged file should dedup");
    assert.equal(secondOut.dedupedMetas[0].path, "C:\\repo\\a.ts");
    assert.equal(secondOut.dedupedMetas[0].contentHash, computeContentHash(contentA));
    assert.equal(secondOut.dedupedMetas[0].round, 1);
    assert.equal(secondOut.dedupedMetas[0].traceIndex, 0);

    // Unchanged file's section is stubbed; changed sibling keeps full content
    assert.equal(secondOut.result.files[0].deduplicated, true);
    assert.match(secondOut.result.files[0].content, /^\[Read dedup:/);
    assert.ok(secondOut.result.files[0].content.includes("firstReadRound=1"));
    assert.ok(secondOut.result.files[0].content.includes("firstReadTrace=0"));

    assert.ok(!secondOut.result.files[1].deduplicated);
    assert.equal(secondOut.result.files[1].content, contentB2);

    // Audit copy (secondRaw) must NOT be mutated in place
    assert.equal(secondRaw.files[0].content, contentA);
    assert.equal(secondRaw.files[0].deduplicated, undefined);

    // Third multi-read with b.ts unchanged at V2 dedups b.ts against round 3 / trace 5
    const thirdRaw = makeMultiResult([
      { path: "C:\\repo\\a.ts", content: contentA },
      { path: "C:\\repo\\b.ts", content: contentB2 },
    ]);
    const thirdOut = registry.checkAndRecordMultiRead("host_read_file", thirdRaw, 5, 9);
    assert.equal(thirdOut.dedupedMetas.length, 2);
    assert.ok(thirdOut.result.files[1].content.includes("firstReadRound=3"));
    assert.ok(thirdOut.result.files[1].content.includes("firstReadTrace=5"));
  });

  it("cross-mode dedup: single-read then multi-read (and vice versa) shares the same per-file registry", () => {
    const registry = new ReadDedupRegistry([]);
    const contentA = "1 | export const shared = true;\n2 | export const count = 42;";

    // Single read first
    const singlePayload = JSON.stringify({
      success: true,
      path: "C:\\repo\\shared.ts",
      content: contentA,
    });
    const d1 = registry.checkAndRecord(
      "host_read_file",
      { path: "C:\\repo\\shared.ts" },
      singlePayload,
      1,
      0
    );
    assert.equal(d1.deduplicated, false);

    // Multi-read containing the same file stubs it
    const multiRaw = makeMultiResult([
      { path: "C:\\repo\\shared.ts", content: contentA },
      { path: "C:\\repo\\fresh.ts", content: "1 | export const fresh = 1;" },
    ]);
    const m1 = registry.checkAndRecordMultiRead("host_read_file", multiRaw, 2, 1);
    assert.equal(m1.dedupedMetas.length, 1);
    assert.equal(m1.result.files[0].deduplicated, true);
    assert.equal(m1.result.files[1].content, "1 | export const fresh = 1;");

    // Subsequent single-read of fresh.ts dedups against the multi-read!
    const singleFresh = JSON.stringify({
      success: true,
      path: "C:\\repo\\fresh.ts",
      content: "1 | export const fresh = 1;",
    });
    const d2 = registry.checkAndRecord(
      "host_read_file",
      { path: "C:\\repo\\fresh.ts" },
      singleFresh,
      3,
      2
    );
    assert.equal(d2.deduplicated, true);
    assert.match(d2.stub!, /firstReadRound=2/);
    assert.match(d2.stub!, /firstReadTrace=1/);
  });

  it("seeds per-file entries from prior turn multi-read messages in the constructor", () => {
    const contentA = "1 | prior turn file alpha";
    const priorMulti = makeMultiResult([{ path: "C:\\repo\\prior.ts", content: contentA }]);
    const priorMessages = [
      { role: "user", content: "read dir" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_m1",
            function: {
              name: "host_read_file",
              arguments: JSON.stringify({ paths: ["C:\\repo"] }),
            },
          },
        ],
      },
      {
        role: "tool",
        name: "host_read_file",
        tool_call_id: "call_m1",
        content: JSON.stringify(priorMulti),
      },
    ];

    const registry = new ReadDedupRegistry(priorMessages);
    const nextMulti = makeMultiResult([{ path: "C:\\repo\\prior.ts", content: contentA }]);
    const out = registry.checkAndRecordMultiRead("host_read_file", nextMulti, 1, 0);
    assert.equal(out.dedupedMetas.length, 1);
    assert.equal(out.result.files[0].deduplicated, true);
    assert.match(out.result.files[0].content, /firstReadMessage=2/);
  });
});

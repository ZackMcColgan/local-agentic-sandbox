import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import {
  getOperatorMemoryPath,
  loadOperatorMemory,
  saveOperatorMemory,
  formatMemoryForContext,
  OPERATOR_MEMORY_MAX_CHARS,
  OWNER_MEMORY_HEADER
} from "../lib/memory/operatorMemory.js";

describe("Settings Memory — operator-memory.json store", () => {
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "opmem-test-"));

  it("getOperatorMemoryPath respects OPERATOR_MEMORY_PATH env var", () => {
    const original = process.env.OPERATOR_MEMORY_PATH;
    try {
      const custom = path.join(os.tmpdir(), "custom-operator-memory.json");
      process.env.OPERATOR_MEMORY_PATH = custom;
      assert.equal(getOperatorMemoryPath(), path.resolve(custom));
    } finally {
      if (original) process.env.OPERATOR_MEMORY_PATH = original;
      else delete process.env.OPERATOR_MEMORY_PATH;
    }
  });

  it("default path is runtime .agent/settings/operator-memory.json (never a repo-tracked path)", () => {
    const original = process.env.OPERATOR_MEMORY_PATH;
    try {
      delete process.env.OPERATOR_MEMORY_PATH;
      const p = getOperatorMemoryPath();
      assert.ok(p.includes(path.join(".agent", "settings")), `default path must live under .agent/settings: ${p}`);
      assert.ok(p.endsWith("operator-memory.json"));
    } finally {
      if (original) process.env.OPERATOR_MEMORY_PATH = original;
    }
  });

  it("missing file loads as empty memory without crashing", () => {
    const dir = mk();
    try {
      const mem = loadOperatorMemory(path.join(dir, "missing.json"));
      assert.equal(mem.text, "");
      assert.ok(typeof mem.updatedAt === "string");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("corruption tolerance: garbage bytes load as empty memory, never throw", () => {
    const dir = mk();
    const p = path.join(dir, "corrupted.json");
    fs.writeFileSync(p, "{ not json ::: \x00\x01 ]]]", "utf8");
    try {
      const mem = loadOperatorMemory(p);
      assert.equal(mem.text, "");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("corruption tolerance: non-object JSON (array/string) loads as empty memory", () => {
    const dir = mk();
    const p = path.join(dir, "array.json");
    fs.writeFileSync(p, JSON.stringify(["a", "b"]), "utf8");
    try {
      const mem = loadOperatorMemory(p);
      assert.equal(mem.text, "");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("save/load round-trip preserves text and updatedAt", () => {
    const dir = mk();
    const p = path.join(dir, "store.json");
    try {
      saveOperatorMemory("hello standing facts", p);
      const mem = loadOperatorMemory(p);
      assert.equal(mem.text, "hello standing facts");
      assert.ok(!Number.isNaN(Date.parse(mem.updatedAt)), "updatedAt must be a valid ISO string");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("empty string is a valid saved state", () => {
    const dir = mk();
    const p = path.join(dir, "store.json");
    try {
      saveOperatorMemory("", p);
      const mem = loadOperatorMemory(p);
      assert.equal(mem.text, "");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("server-side cap: exactly 2000 characters accepted", () => {
    const dir = mk();
    const p = path.join(dir, "store.json");
    try {
      const text = "x".repeat(OPERATOR_MEMORY_MAX_CHARS);
      saveOperatorMemory(text, p);
      assert.equal(loadOperatorMemory(p).text, text);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("server-side cap: 2001 characters rejected with clear error, never silently truncated", () => {
    const dir = mk();
    const p = path.join(dir, "store.json");
    try {
      const text = "x".repeat(OPERATOR_MEMORY_MAX_CHARS + 1);
      assert.throws(
        () => saveOperatorMemory(text, p),
        (err: Error) => err.message.includes(String(OPERATOR_MEMORY_MAX_CHARS)),
        "save must reject over-cap text naming the cap"
      );
      assert.equal(fs.existsSync(p), false, "rejected save must not write anything");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("formatMemoryForContext: empty memory yields empty string (no-op)", () => {
    assert.equal(formatMemoryForContext(""), "");
    assert.equal(formatMemoryForContext("   "), "");
  });

  it("formatMemoryForContext: non-empty memory uses the exact OWNER MEMORY header", () => {
    const ctx = formatMemoryForContext("Repo checkout lives on the host desktop.");
    assert.ok(ctx.includes(OWNER_MEMORY_HEADER), "must contain exact OWNER MEMORY header");
    assert.ok(ctx.includes("Repo checkout lives on the host desktop."));
  });
});

describe("Settings Memory — API route GET/PUT", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opmem-api-"));
  const memPath = path.join(dir, "operator-memory.json");
  process.env.OPERATOR_MEMORY_PATH = memPath;

  it("GET returns { text, updatedAt } and starts empty", async () => {
    const { GET } = await import("../app/api/settings/memory/route.js");
    const res = await GET();
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.text, "");
  });

  it("PUT saves valid text and GET reflects it", async () => {
    const { PUT } = await import("../app/api/settings/memory/route.js");
    const res = await PUT(new Request("http://localhost/api/settings/memory", {
      method: "PUT",
      body: JSON.stringify({ text: "zack's facts" })
    }));
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.text, "zack's facts");

    const { GET } = await import("../app/api/settings/memory/route.js");
    const again = await (await GET()).json();
    assert.equal(again.text, "zack's facts");
  });

  it("PUT with 2001 chars is rejected server-side with 400", async () => {
    const { PUT } = await import("../app/api/settings/memory/route.js");
    const res = await PUT(new Request("http://localhost/api/settings/memory", {
      method: "PUT",
      body: JSON.stringify({ text: "x".repeat(OPERATOR_MEMORY_MAX_CHARS + 1) })
    }));
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.ok(json.error.includes(String(OPERATOR_MEMORY_MAX_CHARS)));
  });

  it("PUT with non-string text is rejected with 400", async () => {
    const { PUT } = await import("../app/api/settings/memory/route.js");
    const res = await PUT(new Request("http://localhost/api/settings/memory", {
      method: "PUT",
      body: JSON.stringify({ text: 42 })
    }));
    assert.equal(res.status, 400);
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.OPERATOR_MEMORY_PATH;
  });
});

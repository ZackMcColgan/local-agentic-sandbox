import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { GET } from "../app/api/files/route.js";
import { NextRequest } from "next/server";

describe("Fix 1.3: Artifact preview files API endpoint", () => {
  it("serves markdown files with HTTP 200 and text/markdown Content-Type", async () => {
    const fixturePath = path.resolve(process.cwd(), "test-preview-artifact.md");
    fs.writeFileSync(fixturePath, "# Test Markdown Artifact\n- Item 1\n", "utf8");

    try {
      const req = new NextRequest("http://localhost:3000/api/files?path=test-preview-artifact.md");
      const res = await GET(req);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
      const body = await res.text();
      assert.ok(body.includes("# Test Markdown Artifact"));
    } finally {
      if (fs.existsSync(fixturePath)) fs.unlinkSync(fixturePath);
    }
  });

  it("rejects non-allowlisted executable files with HTTP 415", async () => {
    const req = new NextRequest("http://localhost:3000/api/files?path=test.exe");
    const res = await GET(req);
    assert.equal(res.status, 415);
  });

  it("serves code and config files (.py, .ts, .yaml) with HTTP 200", async () => {
    const pyPath = path.resolve(process.cwd(), "test-script.py");
    const tsPath = path.resolve(process.cwd(), "test-util.ts");
    const yamlPath = path.resolve(process.cwd(), "test-config.yaml");

    fs.writeFileSync(pyPath, "print('hello')", "utf8");
    fs.writeFileSync(tsPath, "export const x = 1;", "utf8");
    fs.writeFileSync(yamlPath, "key: value", "utf8");

    try {
      const resPy = await GET(new NextRequest("http://localhost:3000/api/files?path=test-script.py"));
      assert.equal(resPy.status, 200);
      assert.ok(resPy.headers.get("content-type")?.includes("text/plain"));
      const bodyPy = await resPy.text();
      assert.ok(bodyPy.includes("print('hello')"));

      const resTs = await GET(new NextRequest("http://localhost:3000/api/files?path=test-util.ts"));
      assert.equal(resTs.status, 200);
      assert.ok(resTs.headers.get("content-type")?.includes("text/plain"));

      const resYaml = await GET(new NextRequest("http://localhost:3000/api/files?path=test-config.yaml"));
      assert.equal(resYaml.status, 200);
      assert.ok(resYaml.headers.get("content-type")?.includes("text/plain"));
    } finally {
      if (fs.existsSync(pyPath)) fs.unlinkSync(pyPath);
      if (fs.existsSync(tsPath)) fs.unlinkSync(tsPath);
      if (fs.existsSync(yamlPath)) fs.unlinkSync(yamlPath);
    }
  });

  it("blocks directory traversal with HTTP 403", async () => {
    const req = new NextRequest("http://localhost:3000/api/files?path=../../../etc/passwd");
    const res = await GET(req);
    assert.equal(res.status, 403);
  });
});


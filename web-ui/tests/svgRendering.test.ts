import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
  isSvgCode,
  sanitizeSvg,
  wrapRawSvgInMarkdown,
  isSvgFilePath,
  resolveSvgUrl
} from "../lib/svgUtils.js";

describe("SVG Rendering & Sanitization Suite", () => {
  it("detects SVG code by language flag or SVG XML structure", () => {
    assert.equal(isSvgCode("<svg></svg>", "svg"), true);
    assert.equal(isSvgCode("<svg viewBox='0 0 100 100'><circle r='10'/></svg>", "xml"), true);
    assert.equal(isSvgCode("<?xml version='1.0'?><svg viewBox='0 0 100 100'></svg>", "bash"), true);
    assert.equal(isSvgCode("function test() { return 42; }", "javascript"), false);
    assert.equal(isSvgCode("echo 'hello'", "bash"), false);
  });

  it("sanitizes potentially malicious scripts and event handlers from SVG while preserving vector elements", () => {
    const maliciousSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" onload="alert('pwned')">
        <script>alert('xss');</script>
        <circle cx="50" cy="50" r="40" fill="#10b981" onclick="stealCookies()" />
        <a href="javascript:alert(1)"><text x="10" y="20">Click</text></a>
      </svg>
    `;

    const sanitized = sanitizeSvg(maliciousSvg);

    assert.equal(sanitized.includes("<script>"), false, "Must strip <script> tag");
    assert.equal(sanitized.includes("alert('xss')"), false, "Must strip script body");
    assert.equal(sanitized.includes("onload="), false, "Must strip onload event handler");
    assert.equal(sanitized.includes("onclick="), false, "Must strip onclick event handler");
    assert.equal(sanitized.includes("javascript:"), false, "Must strip javascript: link");
    assert.ok(sanitized.includes("<circle cx=\"50\" cy=\"50\" r=\"40\" fill=\"#10b981\""), "Must preserve vector circle");
    assert.ok(sanitized.includes("viewBox=\"0 0 100 100\""), "Must preserve viewBox");
  });

  it("wraps unescaped raw SVG blocks into markdown svg code fences", () => {
    const rawContent = `Here is the requested diagram:
<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
  <rect width="200" height="100" fill="#3b82f6" />
</svg>
Hope this helps!`;

    const wrapped = wrapRawSvgInMarkdown(rawContent);

    assert.ok(wrapped.includes("```svg\n<svg viewBox="), "Must wrap raw svg into ```svg block");
    assert.ok(wrapped.includes("</svg>\n```"), "Must close code fence");
    assert.ok(wrapped.includes("Here is the requested diagram:"), "Preserves surrounding text");

    // Must not double-wrap if already inside code fences
    const alreadyFenced = "```svg\n<svg viewBox='0 0 10 10'></svg>\n```";
    assert.equal(wrapRawSvgInMarkdown(alreadyFenced), alreadyFenced);
  });

  it("detects SVG file paths and correctly resolves relative workspace URLs", () => {
    assert.equal(isSvgFilePath("docs/architecture.drawio.svg"), true);
    assert.equal(isSvgFilePath("/workspace/diagram.SVG?version=2"), true);
    assert.equal(isSvgFilePath("docs/report.pdf"), false);
    assert.equal(isSvgFilePath("main.ts"), false);

    assert.equal(
      resolveSvgUrl("docs/architecture.drawio.svg"),
      "/api/files?path=docs%2Farchitecture.drawio.svg"
    );
    assert.equal(
      resolveSvgUrl("https://example.com/logo.svg"),
      "https://example.com/logo.svg"
    );
    assert.equal(
      resolveSvgUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="),
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="
    );
  });

  it("GET /api/files serves workspace SVG files safely and blocks path traversal", async () => {
    const { GET } = await import("../app/api/files/route.js");
    const { NextRequest } = await import("next/server");

    // 1. Successful SVG fetch
    const validReq = new NextRequest("http://localhost:3000/api/files?path=docs/architecture.drawio.svg");
    const res = await GET(validReq);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("Content-Type")?.includes("image/svg+xml"));
    const body = await res.text();
    assert.ok(body.includes("<svg"), "Must return SVG markup");

    // 2. Path traversal attack rejected
    const traversalReq = new NextRequest("http://localhost:3000/api/files?path=../../../../etc/passwd");
    const traversalRes = await GET(traversalReq);
    assert.equal(traversalRes.status, 403, "Path traversal must return 403 Forbidden");

    // 3. Nonexistent file returns 404
    const notFoundReq = new NextRequest("http://localhost:3000/api/files?path=docs/does-not-exist.svg");
    const notFoundRes = await GET(notFoundReq);
    assert.equal(notFoundRes.status, 404, "Missing file must return 404 Not Found");
  });
});


import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
  isSvgCode,
  isDrawioXml,
  convertDrawioToSvg,
  sanitizeSvg,
  wrapRawSvgInMarkdown,
  isSvgFilePath,
  resolveSvgUrl
} from "../lib/svgUtils.js";

describe("SVG Rendering & Sanitization Suite", () => {
  it("detects SVG code and Draw.io XML by language flag or structure", () => {
    assert.equal(isSvgCode("<svg></svg>", "svg"), true);
    assert.equal(isSvgCode("<svg viewBox='0 0 100 100'><circle r='10'/></svg>", "xml"), true);
    assert.equal(isSvgCode("<?xml version='1.0'?><svg viewBox='0 0 100 100'></svg>", "bash"), true);
    assert.equal(isSvgCode("<mxfile host='app.diagrams.net'><diagram><mxGraphModel></mxGraphModel></diagram></mxfile>", "xml"), true);
    assert.equal(isSvgCode("<mxGraphModel><root><mxCell id='0'/></root></mxGraphModel>", ""), true);
    assert.equal(isSvgCode("function test() { return 42; }", "javascript"), false);
    assert.equal(isSvgCode("echo 'hello'", "bash"), false);
  });

  it("detects Draw.io XML diagrams with isDrawioXml", () => {
    assert.equal(isDrawioXml("<mxfile host='app.diagrams.net'><diagram></diagram></mxfile>"), true);
    assert.equal(isDrawioXml("<mxGraphModel><root></root></mxGraphModel>"), true);
    assert.equal(isDrawioXml("<svg><rect/></svg>"), false);
    assert.equal(isDrawioXml("const x = 10;"), false);
  });

  it("converts Draw.io XML into standalone SVG with vertices, shapes, and edges", () => {
    const drawioXml = `<mxfile host="app.diagrams.net">
      <diagram id="d1" name="Two Tier">
        <mxGraphModel>
          <root>
            <mxCell id="0"/>
            <mxCell id="1" parent="0"/>
            <mxCell id="box1" value="Web Tier" style="rounded=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">
              <mxGeometry x="50" y="50" width="120" height="60" as="geometry"/>
            </mxCell>
            <mxCell id="box2" value="Database Tier" style="shape=cylinder;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
              <mxGeometry x="250" y="50" width="120" height="60" as="geometry"/>
            </mxCell>
            <mxCell id="edge1" value="SQL Query" style="endArrow=classic;strokeColor=#2563eb;" edge="1" parent="1" source="box1" target="box2">
              <mxGeometry relative="1" as="geometry"/>
            </mxCell>
          </root>
        </mxGraphModel>
      </diagram>
    </mxfile>`;

    const convertedSvg = convertDrawioToSvg(drawioXml);
    assert.ok(convertedSvg.includes("<svg"), "Must return root <svg> element");
    assert.ok(convertedSvg.includes("viewBox="), "Must compute viewBox");
    assert.ok(convertedSvg.includes("Web Tier"), "Must render Web Tier label");
    assert.ok(convertedSvg.includes("Database Tier"), "Must render Database Tier label");
    assert.ok(convertedSvg.includes("SQL Query"), "Must render edge label");
    assert.ok(convertedSvg.includes("rect") || convertedSvg.includes("path"), "Must render shape elements");
  });

  it("sanitizeSvg converts Draw.io XML to clean SVG and strips malicious attributes", () => {
    const drawioWithXss = `<mxfile host="app.diagrams.net">
      <diagram id="d2">
        <mxGraphModel>
          <root>
            <mxCell id="0"/>
            <mxCell id="1" parent="0"/>
            <mxCell id="xss1" value="Safe Node" style="rounded=1;" vertex="1" parent="1">
              <mxGeometry x="10" y="10" width="100" height="50" as="geometry"/>
            </mxCell>
          </root>
        </mxGraphModel>
      </diagram>
    </mxfile>`;

    const sanitized = sanitizeSvg(drawioWithXss);
    assert.ok(sanitized.includes("<svg"), "Must produce SVG markup");
    assert.ok(sanitized.includes("Safe Node"), "Preserves diagram node text");
    assert.equal(sanitized.includes("<mxfile"), false, "Must replace mxfile with svg");
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

  it("extractSvgsFromMessage extracts vector SVGs from tool traces (write, read, stdout)", async () => {
    const { extractSvgsFromMessage } = await import("../lib/svgUtils.js");

    // Case 1: workspace_write_file trace
    const msgWithWrite = {
      id: "msg-tool-write",
      content: "The architecture diagram has been generated and saved to two_tier_architecture.svg",
      traces: [
        {
          tool: "workspace_write_file",
          args: {
            path: "two_tier_architecture.svg",
            content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#10b981"/></svg>'
          },
          result: {
            content: [{ type: "text", text: '{"status":"SUCCESS","path":"two_tier_architecture.svg"}' }]
          }
        }
      ]
    };

    const svgs1 = extractSvgsFromMessage(msgWithWrite);
    assert.equal(svgs1.length, 1);
    assert.equal(svgs1[0].title, "two_tier_architecture.svg");
    assert.ok(svgs1[0].code?.includes("<svg"), "Contains in-memory SVG code");
    assert.ok(svgs1[0].url?.includes("two_tier_architecture.svg"), "Contains resolved file URL");

    // Case 2: workspace_read_file trace with line numbers in stdout
    const msgWithRead = {
      id: "msg-tool-read",
      content: "Here is the existing diagram:",
      traces: [
        {
          tool: "workspace_read_file",
          args: { path: "docs/existing.svg" },
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({
                status: "SUCCESS",
                path: "docs/existing.svg",
                content: "1 | <svg viewBox=\"0 0 50 50\">\n2 |   <circle r=\"20\" fill=\"red\"/>\n3 | </svg>"
              })
            }]
          }
        }
      ]
    };

    const svgs2 = extractSvgsFromMessage(msgWithRead);
    assert.equal(svgs2.length, 1);
    assert.equal(svgs2[0].title, "existing.svg");
    assert.ok(!svgs2[0].code?.includes("1 |"), "Line numbers must be stripped from SVG code");
    assert.ok(svgs2[0].code?.includes("<circle"), "Clean SVG code preserved");

    // Case 3: Deduplication if content already has the same SVG code inline
    const msgDuplicate = {
      id: "msg-duplicate",
      content: 'Here is the diagram: ```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect/></svg>\n```',
      traces: [
        {
          tool: "workspace_write_file",
          args: {
            path: "dup.svg",
            content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect/></svg>'
          }
        }
      ]
    };

    const svgs3 = extractSvgsFromMessage(msgDuplicate);
    assert.equal(svgs3.length, 0, "Must not duplicate SVG if already rendered inline in content");
  });
});



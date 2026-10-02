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


  it("sanitizes adversarial SVG attacks with DOMPurify: script variants, event handlers, javascript/data URIs, foreignObject, animate onbegin, encoded entities", () => {
    // 1. Script tag variants (inline and external)
    const scriptSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><script>alert('pwned')</script><SCRIPT SRC="http://evil.com/xss.js"></SCRIPT><circle cx="50" cy="50" r="40" fill="#10b981"/></svg>`;
    const scriptCleaned = sanitizeSvg(scriptSvg);
    assert.equal(scriptCleaned.includes("<script"), false, "Must strip lowercase <script>");
    assert.equal(scriptCleaned.includes("<SCRIPT"), false, "Must strip uppercase <SCRIPT>");
    assert.equal(scriptCleaned.includes("alert('pwned')"), false, "Must strip script body");
    assert.ok(scriptCleaned.includes("<circle"), "Must preserve legitimate circle");

    // 2. Event handler variants (onload, onclick, onmouseover, onerror)
    const handlersSvg = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle r="10" onclick="alert(2)" onmouseover="alert(3)" onerror="alert(4)"/><rect width="20" height="20"/></svg>`;
    const handlersCleaned = sanitizeSvg(handlersSvg);
    assert.equal(/onload=/i.test(handlersCleaned), false, "Must strip onload");
    assert.equal(/onclick=/i.test(handlersCleaned), false, "Must strip onclick");
    assert.equal(/onmouseover=/i.test(handlersCleaned), false, "Must strip onmouseover");
    assert.equal(/onerror=/i.test(handlersCleaned), false, "Must strip onerror");
    assert.ok(handlersCleaned.includes("<circle"), "Must preserve circle");
    assert.ok(handlersCleaned.includes("<rect"), "Must preserve rect");

    // 3. javascript: and data: URLs
    const urlsSvg = `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>Click</text></a><a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="><text>Data</text></a><image href="javascript:alert(2)"/></svg>`;
    const urlsCleaned = sanitizeSvg(urlsSvg);
    assert.equal(urlsCleaned.includes("javascript:"), false, "Must neutralize javascript: href");
    assert.equal(urlsCleaned.includes("data:text/html"), false, "Must neutralize data:text/html href");

    // 4. <foreignObject> embedding HTML/iframe/script
    const foreignObjectSvg = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="100" height="50"><body xmlns="http://www.w3.org/1999/xhtml"><iframe src="http://evil.com"></iframe><script>steal()</script></body></foreignObject><rect width="50" height="50"/></svg>`;
    const foreignCleaned = sanitizeSvg(foreignObjectSvg);
    assert.equal(foreignCleaned.includes("<foreignObject"), false, "Must strip <foreignObject>");
    assert.equal(foreignCleaned.includes("<iframe"), false, "Must strip <iframe>");
    assert.ok(foreignCleaned.includes("<rect"), "Must preserve valid rect");

    // 5. <animate onbegin="alert(1)">
    const animateSvg = `<svg xmlns="http://www.w3.org/2000/svg"><animate onbegin="alert(1)" attributeName="opacity" from="0" to="1" dur="1s"/><circle r="10"/></svg>`;
    const animateCleaned = sanitizeSvg(animateSvg);
    assert.equal(animateCleaned.includes("onbegin"), false, "Must neutralize onbegin handler");

    // 6. Encoded entity bypasses (e.g. jav&#x09;ascript: and &Tab;)
    const encodedSvg = `<svg xmlns="http://www.w3.org/2000/svg"><a href="jav&#x09;ascript:alert(1)"><circle r="10"/></a></svg>`;
    const encodedCleaned = sanitizeSvg(encodedSvg);
    assert.equal(encodedCleaned.includes("javascript:"), false, "Must neutralize encoded javascript entity href");
  });

  it("preserves a legitimate 30-cell architecture diagram intact across sanitization", () => {
    const archPath = fs.existsSync(path.resolve(process.cwd(), "docs/architecture.drawio"))
      ? path.resolve(process.cwd(), "docs/architecture.drawio")
      : path.resolve(process.cwd(), "../docs/architecture.drawio");
    const drawioContent = fs.readFileSync(archPath, "utf-8");

    // 1. Convert real architecture.drawio to SVG
    const rawSvg = convertDrawioToSvg(drawioContent);
    assert.ok(rawSvg.length > 5000, "Raw SVG must be generated with content");

    // 2. Pass through sanitizeSvg
    const sanitized = sanitizeSvg(rawSvg);
    assert.ok(sanitized.startsWith("<svg"), "Sanitized output must start with <svg");
    assert.ok(sanitized.includes("</svg>"), "Sanitized output must end with </svg>");

    // 3. Verify all 23 non-empty text labels from the 30 cells survived intact
    const expectedLabels = [
      "CLIENT & INGRESS LAYER",
      "Mobile Phone / Workstation Browser",
      "LAN Reverse Proxy Bridge",
      "Public Internet & External Docs",
      "KUBERNETES CLUSTER",
      "web-ui Orchestrator Pod",
      "mcp-runner Tool Boundary",
      "browser-mcp Scraper Pod",
      "otel-collector Jaeger Tracing",
      "builder-tier Toolchain Sandbox",
      "qdrant-service: Qdrant Vector",
      "workspace-pvc Persistent Volum",
      "HOST INFERENCE BOUNDARY",
      "ollama-service",
      "Primary Orchestrator",
      "Inference /api/chat",
      "REST/gRPC",
      "Delegated Build"
    ];

    for (const label of expectedLabels) {
      assert.ok(
        sanitized.includes(label) || sanitized.includes(label.replace(/&/g, "&amp;")),
        `Sanitized SVG must preserve label: '${label}'`
      );
    }

    // 4. Verify shape elements survived
    assert.ok(sanitized.includes("<rect") || sanitized.includes("<path"), "Must preserve vector shapes");
    assert.ok(sanitized.includes("<defs>"), "Must preserve defs");
  });

  it("Draw.io converter robustness: handles round-trip of real docs/architecture.drawio and malformed inputs", () => {
    // 1. Real docs/architecture.drawio
    const archPath = fs.existsSync(path.resolve(process.cwd(), "docs/architecture.drawio"))
      ? path.resolve(process.cwd(), "docs/architecture.drawio")
      : path.resolve(process.cwd(), "../docs/architecture.drawio");
    const drawioContent = fs.readFileSync(archPath, "utf-8");
    const converted = convertDrawioToSvg(drawioContent);
    assert.ok(converted.includes("viewBox="), "Must compute viewBox");
    assert.ok(converted.includes("web-ui Orchestrator Pod"), "Must contain major pod label");

    // 2. Encoded entities (&lt;mxfile ... &lt;mxGraphModel)
    const encodedXml = `&lt;mxfile host="app.diagrams.net"&gt;&lt;diagram&gt;&lt;mxGraphModel&gt;&lt;root&gt;&lt;mxCell id="0"/&gt;&lt;mxCell id="1" parent="0"/&gt;&lt;mxCell id="c1" value="Encoded Box" vertex="1" parent="1"&gt;&lt;mxGeometry x="10" y="10" width="100" height="50" as="geometry"/&gt;&lt;/mxCell&gt;&lt;/root&gt;&lt;/mxGraphModel&gt;&lt;/diagram&gt;&lt;/mxfile&gt;`;
    const fromEncoded = convertDrawioToSvg(encodedXml);
    assert.ok(fromEncoded.includes("<svg"), "Must unescape and convert encoded mxfile");
    assert.ok(fromEncoded.includes("Encoded Box"), "Must render cell label from encoded XML");

    // 3. Malformed / empty input: must return empty string, never throw
    assert.equal(convertDrawioToSvg(""), "");
    assert.equal(convertDrawioToSvg("   "), "");
    assert.equal(convertDrawioToSvg(null as any), "");
    assert.equal(convertDrawioToSvg(undefined as any), "");
    assert.equal(convertDrawioToSvg("<invalid><xml></broken>"), "");
    assert.equal(convertDrawioToSvg("this is plain text"), "");
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

  it("GET /api/files strictly enforces SVG/XML content-types, blocks directory listing and path traversal", async () => {
    const { GET } = await import("../app/api/files/route.js");
    const { NextRequest } = await import("next/server");

    // 1. Successful SVG fetch
    const validReq = new NextRequest("http://localhost:3000/api/files?path=docs/architecture.drawio.svg");
    const res = await GET(validReq);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("Content-Type")?.includes("image/svg+xml"));
    const body = await res.text();
    assert.ok(body.includes("<svg"), "Must return SVG markup");

    // 2. Successful Draw.io XML fetch
    const drawioReq = new NextRequest("http://localhost:3000/api/files?path=docs/architecture.drawio");
    const drawioRes = await GET(drawioReq);
    assert.equal(drawioRes.status, 200);
    assert.ok(drawioRes.headers.get("Content-Type")?.includes("xml"));

    // 3. Strict content-type enforcement: Non-SVG/XML file returns 415 Unsupported Media Type
    const nonSvgReq = new NextRequest("http://localhost:3000/api/files?path=package.json");
    const nonSvgRes = await GET(nonSvgReq);
    assert.equal(nonSvgRes.status, 415, "Non-SVG/XML file must return 415 Unsupported Media Type");

    // 4. Directory listing forbidden: requesting a directory returns 403 Forbidden
    const dirReq = new NextRequest("http://localhost:3000/api/files?path=docs");
    const dirRes = await GET(dirReq);
    assert.equal(dirRes.status, 403, "Directory path must return 403 Forbidden");

    // 5. Path traversal attack rejected with 403 Forbidden
    const traversalReq = new NextRequest("http://localhost:3000/api/files?path=../../../../etc/passwd");
    const traversalRes = await GET(traversalReq);
    assert.equal(traversalRes.status, 403, "Path traversal must return 403 Forbidden");

    // 6. Nonexistent SVG returns 404
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



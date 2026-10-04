import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SvgViewer } from "../components/SvgViewer.js";

describe("SVG Viewer Component Suite", () => {
  let win: GlobalWindow;
  let container: HTMLDivElement;
  let root: Root | null = null;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    win = new GlobalWindow({ url: "http://localhost:3000" });
    globalThis.window = win as any;
    globalThis.document = win.document as any;
    globalThis.localStorage = win.localStorage as any;

    container = win.document.createElement("div");
    win.document.body.appendChild(container);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (root) {
      try {
        root.unmount();
      } catch {}
      root = null;
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    globalThis.fetch = originalFetch;
  });

  it("renders SVG code in preview mode by default and renders vector element", async () => {
    const sampleSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#10b981"/></svg>`;

    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(SvgViewer, { code: sampleSvg, title: "Test Vector" }));
    });

    const renderedText = container.textContent || "";
    assert.ok(renderedText.includes("Test Vector") || renderedText.includes("SVG"), "Displays title");
    assert.ok(renderedText.includes("Preview"), "Contains Preview tab");
    assert.ok(renderedText.includes("Code"), "Contains Code tab");

    // Must contain rendered svg tag
    const svgElem = container.querySelector("svg");
    assert.ok(svgElem !== null, "Must contain rendered SVG DOM element");
  });

  it("switches to Code tab when Code button is clicked", async () => {
    const sampleSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#10b981"/></svg>`;

    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(SvgViewer, { code: sampleSvg, title: "Test Vector" }));
    });

    // Find and click the Code tab button
    const buttons = Array.from(container.querySelectorAll("button"));
    const codeBtn = buttons.find((b) => b.textContent?.includes("Code"));
    assert.ok(codeBtn !== undefined, "Code tab button must exist");

    await act(async () => {
      codeBtn.click();
    });

    // In code mode, pre/code element should be visible with code content
    const preElem = container.querySelector("pre");
    assert.ok(preElem !== null, "Must display <pre> element in Code view");
    assert.ok(preElem.textContent?.includes("circle cx="), "Pre contains SVG code");
  });

  it("fetches and renders SVG from file URL", async () => {
    const remoteSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#3b82f6"/></svg>`;

    globalThis.fetch = async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/files?path=docs/architecture.drawio.svg")) {
        return {
          ok: true,
          status: 200,
          text: async () => remoteSvg
        } as any;
      }
      return { ok: false, status: 404 } as any;
    };

    root = createRoot(container);
    await act(async () => {
      root!.render(
        React.createElement(SvgViewer, {
          url: "/api/files?path=docs/architecture.drawio.svg",
          title: "architecture.drawio.svg"
        })
      );
    });

    // Allow fetch resolution
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const renderedText = container.textContent || "";
    assert.ok(renderedText.includes("architecture.drawio.svg"), "Title rendered");
    const svgElem = container.querySelector("svg");
    assert.ok(svgElem !== null, "SVG element rendered after URL fetch");
  });

  it("ChatStream renders SVG code blocks, raw SVGs, and SVG file links", async () => {
    const { ChatStream } = await import("../components/ChatStream.js");

    const testMessages = [
      {
        id: "msg-1",
        role: "assistant" as const,
        content: `Here is the architectural diagram:\n\`\`\`svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="#10b981"/></svg>\n\`\`\`\nAnd here is a link to [architecture.drawio.svg](docs/architecture.drawio.svg).`
      }
    ];

    root = createRoot(container);
    await act(async () => {
      root!.render(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "qwen3.8:27b-q3_k_m",
          reasoningEffort: "medium",
          messages: testMessages,
          setMessages: () => {}
        })
      );
    });

    const renderedText = container.textContent || "";
    assert.ok(renderedText.includes("Preview"), "ChatStream renders SVG Preview tab for code block");
    assert.ok(renderedText.includes("architecture.drawio.svg"), "Renders SVG file link");

    const svgs = container.querySelectorAll("svg");
    assert.ok(svgs.length > 0, "ChatStream renders vector SVG DOM elements");
  });

  it("ChatStream renders tool-generated SVGs from workspace_write_file inline without requiring expanding proof drawer", async () => {
    const { ChatStream } = await import("../components/ChatStream.js");

    // Exact scenario from user bug report:
    // Model responds with tool trace calling workspace_write_file with two_tier_architecture.svg
    // and conversational text mentioning the file, but NO markdown code fence in content.
    const testMessages = [
      {
        id: "msg-tool-svg",
        role: "assistant" as const,
        content: "There we go! The SVG has been written via the tool call to `two_tier_architecture.svg` in your workspace, featuring web and database tiers.",
        traces: [
          {
            tool: "workspace_write_file",
            durationMs: 4,
            timestamp: new Date().toISOString(),
            args: {
              path: "two_tier_architecture.svg",
              content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect id="web-tier" width="90" height="50" fill="#3b82f6"/><rect id="db-tier" x="110" width="90" height="50" fill="#10b981"/></svg>'
            },
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    status: "SUCCESS",
                    path: "two_tier_architecture.svg",
                    bytes_written: 180,
                    is_diagram: true
                  })
                }
              ]
            }
          }
        ]
      }
    ];

    root = createRoot(container);
    await act(async () => {
      root!.render(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "qwen3.8:27b-q3_k_m",
          reasoningEffort: "medium",
          messages: testMessages,
          setMessages: () => {}
        })
      );
    });

    const renderedText = container.textContent || "";
    // 1. Assert header indicates rendered vector diagram
    assert.ok(
      renderedText.includes("Rendered Vector Diagram: two_tier_architecture.svg"),
      "Must render inline vector diagram banner"
    );

    // 2. Assert SVG DOM element exists and contains diagram elements
    const webTier = container.querySelector("#web-tier");
    const dbTier = container.querySelector("#db-tier");
    assert.ok(webTier !== null, "Rendered SVG must contain #web-tier");
    assert.ok(dbTier !== null, "Rendered SVG must contain #db-tier");

    // 3. Assert SvgViewer controls (Preview, Code, Download, Copy) are rendered inline
    assert.ok(renderedText.includes("Preview"), "Preview tab present");
    assert.ok(renderedText.includes("Code"), "Code tab present");

    // 4. Assert proof drawer is still collapsed by default while the SVG is fully visible
    assert.ok(renderedText.includes("Expand Proof"), "Proof drawer remains collapsed without hiding the SVG");
  });

  it("SvgViewer converts Draw.io XML into rendered vector shapes and provides external diagram link", async () => {
    const drawioXml = `<mxfile host="app.diagrams.net">
      <diagram id="d1" name="Two Tier">
        <mxGraphModel>
          <root>
            <mxCell id="0"/>
            <mxCell id="1" parent="0"/>
            <mxCell id="alb" value="ALB Load Balancer" style="shape=cylinder;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
              <mxGeometry x="100" y="50" width="140" height="70" as="geometry"/>
            </mxCell>
          </root>
        </mxGraphModel>
      </diagram>
    </mxfile>`;

    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(SvgViewer, { code: drawioXml, title: "two_tier_aws.drawio.svg" }));
    });

    const renderedText = container.textContent || "";
    assert.ok(renderedText.includes("two_tier_aws.drawio.svg") || renderedText.includes("Draw.io"), "Displays title or Draw.io badge");

    // Must render SVG DOM element containing converted shapes (not an empty canvas!)
    const svgElem = container.querySelector("svg.drawio-svg") || container.querySelector(".drawio-node")?.closest("svg");
    assert.ok(svgElem !== null, "Must contain rendered SVG DOM element");
    assert.ok(svgElem.innerHTML.includes("ALB Load Balancer"), "Must contain rendered node text");

    // Assert Diagrams.net action button exists
    const buttons = Array.from(container.querySelectorAll("button, a"));
    const drawioBtn = buttons.find((b) => b.getAttribute("title")?.includes("Diagrams.net") || b.textContent?.includes("Diagrams.net"));
    assert.ok(drawioBtn !== undefined, "Diagrams.net action button must be available");
  });

  it("ChatStream renders Draw.io XML files inline from tool traces", async () => {
    const { ChatStream } = await import("../components/ChatStream.js");

    const testMessages = [
      {
        id: "msg-drawio-trace",
        role: "assistant" as const,
        content: "I have created the architecture diagram and saved it to two_tier_aws_architecture.drawio.svg.",
        traces: [
          {
            tool: "workspace_write_file",
            durationMs: 5,
            timestamp: new Date().toISOString(),
            args: {
              path: "two_tier_aws_architecture.drawio.svg",
              content: `<mxfile host="app.diagrams.net"><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="ec2" value="App Server" vertex="1" parent="1"><mxGeometry x="10" y="10" width="100" height="50" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`
            },
            result: {
              content: [{ type: "text", text: '{"status":"SUCCESS","path":"two_tier_aws_architecture.drawio.svg"}' }]
            }
          }
        ]
      }
    ];

    root = createRoot(container);
    await act(async () => {
      root!.render(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "qwen3.8:27b-q3_k_m",
          reasoningEffort: "medium",
          messages: testMessages,
          setMessages: () => {}
        })
      );
    });

    const renderedText = container.textContent || "";
    assert.ok(
      renderedText.includes("two_tier_aws_architecture.drawio.svg"),
      "Must render inline vector diagram for drawio.svg"
    );

    const svgElem = container.querySelector("svg.drawio-svg") || container.querySelector(".drawio-node")?.closest("svg");
    assert.ok(svgElem !== null, "Must render SVG DOM element for Draw.io file");
    assert.ok(svgElem.innerHTML.includes("App Server"), "Must render App Server inside SVG");
  });
});




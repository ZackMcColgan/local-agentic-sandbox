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
});


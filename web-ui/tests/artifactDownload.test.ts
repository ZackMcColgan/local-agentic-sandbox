import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { resolveArtifactDownload } from "../lib/artifactDownload.js";
import { inferAttachmentMimeType } from "../lib/attachmentMime.js";
import { CodeBlock } from "../components/ArtifactRenderers.js";

describe("Artifact download naming & MIME", () => {
  it("keeps a known artifact extension in the title and derives MIME from it", () => {
    const html = resolveArtifactDownload("weather-card.html", "<html><body></body></html>", false);
    assert.equal(html.filename, "weather-card.html");
    assert.equal(html.mime, "text/html");

    const drawio = resolveArtifactDownload("chart.drawio", "<mxfile></mxfile>", true);
    assert.equal(drawio.filename, "chart.drawio");
    assert.equal(drawio.mime, "application/xml");
    assert.ok(!drawio.filename.endsWith(".drawio.svg"), "never .drawio.svg");

    const xml = resolveArtifactDownload("report.xml", "<svg></svg>", false);
    assert.equal(xml.filename, "report.xml");
    assert.equal(xml.mime, "application/xml");

    const svg = resolveArtifactDownload("icon.svg", "<svg></svg>", false);
    assert.equal(svg.filename, "icon.svg");
    assert.equal(svg.mime, "image/svg+xml");
  });

  it("appends .svg for titles without a known extension (legacy behavior)", () => {
    const bare = resolveArtifactDownload("diagram", "<svg></svg>", false);
    assert.equal(bare.filename, "diagram.svg");
    assert.equal(bare.mime, "image/svg+xml");

    const drawioNoExt = resolveArtifactDownload("two tier", "<mxfile></mxfile>", true);
    assert.equal(drawioNoExt.filename, "two_tier.drawio");
    assert.equal(drawioNoExt.mime, "application/xml");
  });

  it("inferAttachmentMimeType maps every artifact extension", () => {
    assert.equal(inferAttachmentMimeType("a.html"), "text/html");
    assert.equal(inferAttachmentMimeType("a.svg"), "image/svg+xml");
    assert.equal(inferAttachmentMimeType("a.drawio"), "application/xml");
    assert.equal(inferAttachmentMimeType("a.xml"), "application/xml");
    assert.equal(inferAttachmentMimeType("a.py"), "text/x-python");
    assert.equal(inferAttachmentMimeType("a.json"), "application/json");
    assert.equal(inferAttachmentMimeType("a.md"), "text/markdown");
    assert.equal(inferAttachmentMimeType("a.csv"), "text/csv");
    assert.equal(inferAttachmentMimeType("a.unknown"), "application/octet-stream");
  });

  describe("CodeBlock Download buttons", () => {
    let win: GlobalWindow;
    let container: HTMLDivElement;
    let root: Root | null = null;

    beforeEach(() => {
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
      win = new GlobalWindow({ url: "http://localhost:3000" });
      globalThis.window = win as any;
      globalThis.document = win.document as any;

      const div = win.document.createElement("div");
      win.document.body.appendChild(div);
      container = div as unknown as HTMLDivElement;
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
    });

    it("renders Download button on HTML branch and creates blob on click", async () => {
      let createdBlob: Blob | null = null;
      let clickedDownloadName = "";

      const origCreateObjectURL = (globalThis as any).URL.createObjectURL;
      const origRevokeObjectURL = (globalThis as any).URL.revokeObjectURL;
      (globalThis as any).URL.createObjectURL = (blob: Blob) => {
        createdBlob = blob;
        return "blob:mock-url";
      };
      (globalThis as any).URL.revokeObjectURL = () => {};

      const origAppendChild = win.document.body.appendChild.bind(win.document.body);
      win.document.body.appendChild = ((node: any) => {
        if (node.tagName === "A" && node.download) {
          clickedDownloadName = node.download;
        }
        return origAppendChild(node);
      }) as any;

      try {
        root = createRoot(container);
        await act(async () => {
          root!.render(
            React.createElement(CodeBlock, {
              code: "<html><body><h1>Hello</h1></body></html>",
              language: "html",
              filename: "page.html"
            })
          );
        });

        const dlBtn = Array.from(container.querySelectorAll("button")).find(
          (b) => b.getAttribute("title")?.includes("Download") || b.textContent?.includes("Download")
        );
        assert.ok(dlBtn !== undefined, "HTML CodeBlock must render Download button");

        await act(async () => {
          dlBtn!.click();
        });

        assert.equal(clickedDownloadName, "page.html");
        assert.equal((createdBlob as any)?.type, "text/html;charset=utf-8");
      } finally {
        (globalThis as any).URL.createObjectURL = origCreateObjectURL;
        (globalThis as any).URL.revokeObjectURL = origRevokeObjectURL;
        win.document.body.appendChild = origAppendChild;
      }
    });

    it("renders Download button on generic code branch and creates blob on click", async () => {
      let createdBlob: Blob | null = null;
      let clickedDownloadName = "";

      const origCreateObjectURL = (globalThis as any).URL.createObjectURL;
      const origRevokeObjectURL = (globalThis as any).URL.revokeObjectURL;
      (globalThis as any).URL.createObjectURL = (blob: Blob) => {
        createdBlob = blob;
        return "blob:mock-url";
      };
      (globalThis as any).URL.revokeObjectURL = () => {};

      const origAppendChild = win.document.body.appendChild.bind(win.document.body);
      win.document.body.appendChild = ((node: any) => {
        if (node.tagName === "A" && node.download) {
          clickedDownloadName = node.download;
        }
        return origAppendChild(node);
      }) as any;

      try {
        root = createRoot(container);
        await act(async () => {
          root!.render(
            React.createElement(CodeBlock, {
              code: "print('hello world')",
              language: "python",
              filename: "script.py"
            })
          );
        });

        const dlBtn = Array.from(container.querySelectorAll("button")).find(
          (b) => b.getAttribute("title")?.includes("Download") || b.textContent?.includes("Download")
        );
        assert.ok(dlBtn !== undefined, "Generic CodeBlock must render Download button");

        await act(async () => {
          dlBtn!.click();
        });

        assert.equal(clickedDownloadName, "script.py");
        assert.equal((createdBlob as any)?.type, "text/x-python;charset=utf-8");
      } finally {
        (globalThis as any).URL.createObjectURL = origCreateObjectURL;
        (globalThis as any).URL.revokeObjectURL = origRevokeObjectURL;
        win.document.body.appendChild = origAppendChild;
      }
    });
  });
});

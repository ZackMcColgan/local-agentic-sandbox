import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const WEB_UI_ROOT = path.resolve(__dirname, "..");

describe("title/name surfaces use line-clamp-2 instead of single-line truncate", () => {
  it("MorningReportView.tsx and SvgViewer.tsx do not truncate titles with single-line truncate", () => {
    const morning = fs.readFileSync(path.join(WEB_UI_ROOT, "components/MorningReportView.tsx"), "utf8");
    assert.doesNotMatch(
      morning,
      /className="[^"]*truncate[^"]*"[^>]*>\{m\.title\}/,
      "MorningReportView.tsx should not use single-line truncate on {m.title}"
    );

    const svg = fs.readFileSync(path.join(WEB_UI_ROOT, "components/SvgViewer.tsx"), "utf8");
    assert.doesNotMatch(
      svg,
      /className="[^"]*truncate[^"]*"[^>]*>\{title\}/,
      "SvgViewer.tsx should not use single-line truncate on {title}"
    );
  });

  it("FP4: createThread with >40-char first line preserves fuller title up to 80 chars", async () => {
    const os = await import("node:os");
    const { ThreadStore, THREAD_TITLE_MAX_CHARS } = await import("../lib/threads/threadStore");
    assert.ok(THREAD_TITLE_MAX_CHARS >= 80, `Expected THREAD_TITLE_MAX_CHARS >= 80, got ${THREAD_TITLE_MAX_CHARS}`);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fp4-title-cap-"));
    try {
      const store = new ThreadStore(tmpDir);
      const longPrompt = "Investigate why the SSE streaming pipeline drops phaseTimings on reconnect";
      const thread = await store.createThread({ initialPrompt: longPrompt });
      assert.ok(thread.title.length > 40, `Expected title length > 40, got ${thread.title.length}: "${thread.title}"`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("FP4: SvgViewer, MorningReportView, and ArtifactCanvas no longer apply single-line truncate to titles", () => {
    const svgSrc = fs.readFileSync(path.join(process.cwd(), "components", "SvgViewer.tsx"), "utf8");
    const svgLines = svgSrc.split("\n");
    assert.ok(!svgLines[178]?.includes("truncate"), `SvgViewer L179 parent should not have 'truncate': ${svgLines[178]}`);

    const mrSrc = fs.readFileSync(path.join(process.cwd(), "components", "MorningReportView.tsx"), "utf8");
    const mrLines = mrSrc.split("\n");
    assert.ok(!mrLines[619]?.includes("truncate"), `MorningReportView L620 should not have 'truncate': ${mrLines[619]}`);

    const acSrc = fs.readFileSync(path.join(process.cwd(), "components", "ArtifactCanvas.tsx"), "utf8");
    const acLines = acSrc.split("\n");
    assert.ok(!acLines[532]?.includes("truncate"), `ArtifactCanvas L533 should not have 'truncate': ${acLines[532]}`);
  });
});

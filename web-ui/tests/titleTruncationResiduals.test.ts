import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const WEB_UI_ROOT = path.resolve(__dirname, "..");

describe("NEW-ARGON-01 residuals: title/name surfaces use line-clamp-2 instead of single-line truncate", () => {
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
});

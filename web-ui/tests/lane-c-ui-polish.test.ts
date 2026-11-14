import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const WEB_UI_DIR = path.resolve(import.meta.dirname, "..");

function readWebUiFile(relPath: string): string {
  return fs.readFileSync(path.join(WEB_UI_DIR, relPath), "utf8");
}

describe("Lane C UI Polish", () => {
  it("C1 (UI-033): .rail-label permits multi-line wrapping inside 68px .rail-btn with >= 6px horizontal padding", () => {
    const tokensCss = readWebUiFile("app/design-tokens.css");
    const railLabelMatch = tokensCss.match(/\.rail-label\s*\{([^}]*)\}/);
    assert.ok(railLabelMatch, ".rail-label rule must exist in design-tokens.css");
    const railLabelBody = railLabelMatch[1];

    assert.match(railLabelBody, /white-space:\s*normal/, ".rail-label must use white-space: normal");
    assert.match(railLabelBody, /max-width:\s*64px/, ".rail-label must constrain max-width: 64px");
    assert.match(railLabelBody, /overflow-wrap:\s*break-word/, ".rail-label must set overflow-wrap: break-word");
    assert.match(railLabelBody, /text-align:\s*center/, ".rail-label must center text");

    const railBtnMatch = tokensCss.match(/\.rail-btn\s*\{([^}]*)\}/);
    assert.ok(railBtnMatch, ".rail-btn rule must exist in design-tokens.css");
    const railBtnBody = railBtnMatch[1];
    assert.match(railBtnBody, /padding:\s*\d+px\s+(?:[6-9]|\d{2,})px/, ".rail-btn must have >= 6px horizontal padding");
  });

  it("C2 (UI-046 + UI-047 + NEW-ARGON-06): all 4 desktop pane headers share h-12 top bar with border-b and no duplicate Hide buttons", () => {
    const threadsSidebar = readWebUiFile("components/ThreadsSidebar.tsx");
    const chatStream = readWebUiFile("components/ChatStream.tsx");
    const artifactCanvas = readWebUiFile("components/ArtifactCanvas.tsx");
    const pageTsx = readWebUiFile("app/page.tsx");

    // All 4 pane headers use h-12 and border-b
    assert.match(threadsSidebar, /className="[^"]*\bh-12\b[^"]*\bborder-b\b/, "ThreadsSidebar header must use h-12 and border-b");
    assert.match(chatStream, /<header className="[^"]*\bh-12\b[^"]*\bborder-b\b/, "ChatStream header must use h-12 and border-b");
    assert.match(artifactCanvas, /className="flex items-center gap-2 h-12[^"]*\bborder-b\b/, "ArtifactCanvas header must use h-12 and border-b");
    assert.match(pageTsx, /className="inspector-header h-12[^"]*\bborder-b\b/, "Workspace inspector header must use h-12 and border-b");

    // Duplicate Hide buttons removed
    assert.doesNotMatch(threadsSidebar, /« Hide/, "ThreadsSidebar must not render duplicate « Hide button");
    assert.doesNotMatch(pageTsx, /Hide »/, "page.tsx must not render duplicate Hide » button");

    // Mobile back button remains functional in page.tsx
    assert.match(pageTsx, /aria-label="Back to chat"/, "Mobile Back to chat button must remain in page.tsx");
  });
});

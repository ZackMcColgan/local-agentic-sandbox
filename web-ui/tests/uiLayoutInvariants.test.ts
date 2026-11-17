import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const WEB_UI = path.resolve(process.cwd());

describe("E9: Non-chat view container widths (UI-044)", () => {
  it("SettingsView, BuildsView, SkillsView, and page.tsx Morning Report container all use max-w-4xl", () => {
    const files = [
      "components/SettingsView.tsx",
      "components/BuildsView.tsx",
      "components/SkillsView.tsx",
      "app/page.tsx",
    ];
    for (const rel of files) {
      const content = fs.readFileSync(path.join(WEB_UI, rel), "utf8");
      assert.ok(content.includes("max-w-4xl"), `Expected ${rel} to use max-w-4xl`);
    }
  });
});

describe("E10: App icon / favicon 404 elimination (UI-045)", () => {
  it("web-ui/app/icon.svg exists and web-ui/app/layout.tsx configures icons in metadata", () => {
    const iconPath = path.join(WEB_UI, "app", "icon.svg");
    assert.ok(fs.existsSync(iconPath), "Expected web-ui/app/icon.svg to exist");
    const layoutContent = fs.readFileSync(path.join(WEB_UI, "app", "layout.tsx"), "utf8");
    assert.ok(layoutContent.includes("icons:"), "Expected metadata.icons in app/layout.tsx");
    assert.ok(layoutContent.includes("/icon.svg"), "Expected /icon.svg in app/layout.tsx");
  });
});

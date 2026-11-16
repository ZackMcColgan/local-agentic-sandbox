import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as chatUtils from "../lib/chatUtils.js";

describe("P0.5 — Stray UI fixes", () => {
  it("UI-010: joinNarrationChunks inserts a separator when neither side has boundary whitespace", () => {
    const joinFn = (chatUtils as any).joinNarrationChunks;
    assert.equal(typeof joinFn, "function", "Expected joinNarrationChunks to be exported from lib/chatUtils.ts");
    assert.equal(joinFn("…runlog.", "Both runs green…"), "…runlog. Both runs green…");
    assert.equal(joinFn("hello ", "world"), "hello world");
    assert.equal(joinFn("hello", " world"), "hello world");
    assert.equal(joinFn("", "world"), "world");
  });

  it("P0.5a: page.tsx app-shell uses design-tokens grid (no conflicting flex classes) and renders mobile-bottom-nav", () => {
    const pageSrc = fs.readFileSync(path.resolve(process.cwd(), "app/page.tsx"), "utf8");
    assert.ok(!pageSrc.includes("app-shell h-[100dvh] flex flex-col md:flex-row"), "app-shell must not have conflicting flex classes");
    assert.ok(pageSrc.includes("mobile-bottom-nav"), "page.tsx must render .mobile-bottom-nav");
  });

  it("P0.5b: SettingsView mounts EngineStatusPill", () => {
    const settingsSrc = fs.readFileSync(path.resolve(process.cwd(), "components/SettingsView.tsx"), "utf8");
    assert.ok(settingsSrc.includes("EngineStatusPill"), "SettingsView must mount EngineStatusPill");
  });
});

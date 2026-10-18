import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

describe("Engine Status Pill & Settings Toggle UI Components", () => {
  const componentsDir = path.resolve(__dirname, "../components");
  const pillFile = fs.readFileSync(path.join(componentsDir, "EngineStatusPill.tsx"), "utf-8");
  const settingsFile = fs.readFileSync(path.join(componentsDir, "SettingsView.tsx"), "utf-8");
  const chatFile = fs.readFileSync(path.join(componentsDir, "ChatStream.tsx"), "utf-8");

  describe("EngineStatusPill Component", () => {
    it("renders running state with emerald dot and 'Engine' text", () => {
      assert.ok(pillFile.includes("bg-emerald-500"), "Must have green dot for running state");
      assert.ok(pillFile.includes("Engine"), "Must have 'Engine' label");
      assert.ok(pillFile.includes('role="status"'), "Must have accessible role=status");
    });

    it("renders stopped state with gray dot, 'Engine Stopped' label, and touch-friendly Start button", () => {
      assert.ok(
        pillFile.includes("bg-slate-400") || pillFile.includes("bg-zinc-600"),
        "Must have gray dot for stopped state"
      );
      assert.ok(pillFile.includes("Engine Stopped"), "Must display 'Engine Stopped'");
      assert.ok(pillFile.includes("Start"), "Must display 'Start' button");
      assert.ok(
        pillFile.includes("min-h-[44px]") || pillFile.includes("min-h-[36px]"),
        "Must provide touch target for mobile interaction"
      );
    });

    it("renders starting state with pulsing amber dot and 'Starting...' text", () => {
      assert.ok(
        pillFile.includes("bg-amber-500") && pillFile.includes("animate-pulse"),
        "Must have pulsing amber dot for starting state"
      );
      assert.ok(pillFile.includes("Starting..."), "Must display 'Starting...' text");
    });

    it("polls /api/engine periodically and posts start action", () => {
      assert.ok(pillFile.includes("/api/engine"), "Must reference /api/engine");
      assert.ok(pillFile.includes('action: "start"'), "Must post action: start when Start button is clicked");
    });
  });

  describe("ChatStream Integration", () => {
    it("mounts EngineStatusPill in top header bar", () => {
      assert.ok(
        chatFile.includes("<EngineStatusPill"),
        "ChatStream header must render EngineStatusPill component"
      );
      assert.ok(
        chatFile.includes("import { EngineStatusPill }"),
        "ChatStream must import EngineStatusPill"
      );
    });
  });

  describe("SettingsView Engine Management Section", () => {
    it("displays Section 4: Engine Management with Standalone llama.cpp", () => {
      assert.ok(
        settingsFile.includes("Engine Management"),
        "SettingsView must contain 'Engine Management' heading"
      );
      assert.ok(
        settingsFile.includes("Standalone llama.cpp"),
        "SettingsView must indicate Standalone llama.cpp"
      );
      assert.ok(
        settingsFile.includes("16GB VRAM") || settingsFile.includes("16,384 MB"),
        "SettingsView must display 16GB VRAM estimate"
      );
    });

    it("provides Start, Stop, and Restart action buttons with proper disable states", () => {
      assert.ok(settingsFile.includes("Start"), "Must include Start button");
      assert.ok(settingsFile.includes("Stop"), "Must include Stop button");
      assert.ok(settingsFile.includes("Restart"), "Must include Restart button");

      // Verify disabled attributes
      assert.ok(
        settingsFile.includes('engineData.status === "running"'),
        "Start button must disable when engine is running"
      );
      assert.ok(
        settingsFile.includes('engineData.status === "stopped"'),
        "Stop button must disable when engine is stopped"
      );
    });

    it("invokes /api/engine with start, stop, and restart actions", () => {
      assert.ok(
        settingsFile.includes('/api/engine'),
        "SettingsView must communicate with /api/engine"
      );
      assert.ok(
        settingsFile.includes('action: "start"') || settingsFile.includes("handleEngineAction(\"start\")"),
        "SettingsView must dispatch start action"
      );
      assert.ok(
        settingsFile.includes('action: "stop"') || settingsFile.includes("handleEngineAction(\"stop\")"),
        "SettingsView must dispatch stop action"
      );
      assert.ok(
        settingsFile.includes('action: "restart"') || settingsFile.includes("handleEngineAction(\"restart\")"),
        "SettingsView must dispatch restart action"
      );
    });
  });
});

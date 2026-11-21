import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EngineZone } from "../components/settings/EngineZone";

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

    it("renders stopped state with neutral stone dot, 'Engine Stopped' label, and touch-friendly Start button", () => {
      assert.ok(
        pillFile.includes("bg-stone-400") || pillFile.includes("bg-stone-500"),
        "Must have neutral stone dot for stopped state"
      );
      assert.ok(pillFile.includes("Engine Stopped"), "Must display 'Engine Stopped'");
      assert.ok(pillFile.includes("Start"), "Must display 'Start' button");
      assert.ok(
        pillFile.includes("min-h-[44px]") || pillFile.includes("min-h-[36px]"),
        "Must provide touch target for mobile interaction"
      );
    });

    it("renders starting state with pulsing emerald dot and 'Starting...' text", () => {
      assert.ok(
        pillFile.includes("bg-emerald-500") && pillFile.includes("animate-pulse"),
        "Must have pulsing emerald dot for starting state"
      );
      assert.ok(pillFile.includes("Starting..."), "Must display 'Starting...' text");
    });

    it("polls /api/engine periodically and posts start action", () => {
      assert.ok(pillFile.includes("/api/engine"), "Must reference /api/engine");
      assert.ok(
        pillFile.includes('action: "start"'),
        "Must post action: start when Start button is clicked"
      );
    });
  });

  describe("ChatStream Integration", () => {
    // uir-0 header diet (owner ruling Nov 12, 2026): the Engine pill left the
    // chat header; engine status and controls live in Settings. The pill
    // component itself is unchanged and still covered above.
    it("does NOT mount EngineStatusPill in the chat header (uir-0 header diet)", () => {
      assert.ok(
        !chatFile.includes("<EngineStatusPill"),
        "ChatStream header must not render EngineStatusPill after the header diet"
      );
      assert.ok(
        !chatFile.includes("import { EngineStatusPill }"),
        "ChatStream must not import EngineStatusPill after the header diet"
      );
    });
  });

  describe("SettingsView Engine Management Section", () => {
    it("displays Engine Management section with reported engine identity and honest VRAM fallback", () => {
      const html = renderToStaticMarkup(
        React.createElement(EngineZone, {
          engineData: {
            status: "stopped",
            reachable: false,
            engine: "custom-engine",
            model: null,
            vram_mb: null,
          },
          engineLoading: false,
          engineMessage: null,
          activeModel: "qwen3.8-flash-next",
          reasoningEffort: "low",
          onEngineAction: () => {},
        })
      );
      assert.ok(
        html.includes("Engine Management"),
        "EngineZone must contain 'Engine Management' heading"
      );
      assert.ok(
        html.includes("custom-engine"),
        "EngineZone must derive engine identity from engineData"
      );
      assert.ok(
        html.includes("Not reported by this engine"),
        "EngineZone must render explicit 'Not reported by this engine' fallback when VRAM is unreported"
      );
    });

    it("provides Start, Stop, and Restart action buttons with proper disable states", () => {
      const runningHtml = renderToStaticMarkup(
        React.createElement(EngineZone, {
          engineData: { status: "running", reachable: true },
          engineLoading: false,
          engineMessage: null,
          activeModel: "qwen3.8-flash-next",
          reasoningEffort: "low",
          onEngineAction: () => {},
        })
      );
      assert.ok(runningHtml.includes("Start"), "Must include Start button");
      assert.ok(runningHtml.includes("Stop"), "Must include Stop button");
      assert.ok(runningHtml.includes("Restart"), "Must include Restart button");
      assert.ok(
        runningHtml.includes('disabled=""') && runningHtml.includes('aria-label="Start llama-server"'),
        "Start button must disable when engine is running"
      );

      const stoppedHtml = renderToStaticMarkup(
        React.createElement(EngineZone, {
          engineData: { status: "stopped", reachable: false },
          engineLoading: false,
          engineMessage: null,
          activeModel: "qwen3.8-flash-next",
          reasoningEffort: "low",
          onEngineAction: () => {},
        })
      );
      assert.ok(
        stoppedHtml.includes('disabled=""') && stoppedHtml.includes('aria-label="Stop llama-server"'),
        "Stop button must disable when engine is stopped"
      );
    });

    it("invokes /api/engine with start, stop, and restart actions", () => {
      assert.ok(
        settingsFile.includes("/api/engine"),
        "SettingsView must communicate with /api/engine"
      );
      assert.ok(
        settingsFile.includes("handleEngineAction"),
        "SettingsView must pass handleEngineAction to EngineZone"
      );
    });
  });

  describe("ModelBottomSheet Engine Management & AppShell Mobile Classes", () => {
    const modelSheetFile = fs.readFileSync(
      path.join(componentsDir, "ModelBottomSheet.tsx"),
      "utf-8"
    );
    const pageFile = fs.readFileSync(path.resolve(__dirname, "../app/page.tsx"), "utf-8");

    it("EngineStatusPill provides Stop button when running and posts action: stop", () => {
      assert.ok(pillFile.includes("Stop"), "EngineStatusPill must contain Stop button");
      assert.ok(pillFile.includes('action: "stop"'), "EngineStatusPill must post action: stop");
    });

    it("ModelBottomSheet provides Engine Management card with toggle", () => {
      assert.ok(
        modelSheetFile.includes("Standalone llama.cpp Engine"),
        "Must contain engine label"
      );
      assert.ok(
        modelSheetFile.includes("Start Engine"),
        "Must contain Start Engine button when stopped"
      );
      assert.ok(modelSheetFile.includes("/api/engine"), "Must call /api/engine");
    });

    it("page.tsx applies mobile-sidebar-open and mobile-inspector-open to app-shell", () => {
      assert.ok(
        pageFile.includes("mobile-sidebar-open"),
        "app-shell must include mobile-sidebar-open class"
      );
      assert.ok(
        pageFile.includes("mobile-inspector-open"),
        "app-shell must include mobile-inspector-open class"
      );
    });
  });
});

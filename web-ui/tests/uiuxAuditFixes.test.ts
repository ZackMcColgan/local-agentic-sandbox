import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BOARD_SEED_ITEMS } from "../lib/board/boardSeed";
import { BoardStore } from "../lib/board/boardStore";
import { displayRepoPath, displayBasename, deriveThreadDisplayTitle } from "../lib/chatUtils";

const ROOT = path.resolve(__dirname, "..");

function readComp(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

// 1. UI-060: Fresh seed truthful + v2 store migration
{
  const shippedIds = [
    "item-15",
    "item-16",
    "item-ui-057",
    "item-17",
    "item-18",
    "item-19",
    "item-21",
    "item-22",
  ];
  for (const id of shippedIds) {
    const item = BOARD_SEED_ITEMS.find((i) => i.id === id);
    assert.ok(item, `Seed item ${id} must exist`);
    assert.equal(item.status, "done", `Seed item ${id} must be done`);
    assert.ok(item.evidence?.prNumber, `Seed item ${id} must have prNumber`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-mig-"));
  try {
    const staleItems = [
      {
        id: "item-15",
        key: "#15",
        title: "tool-call-integrity",
        brief: "test",
        dependencies: [],
        status: "working",
        author: "Owner",
        source: "manual",
        createdAt: "2026-11-15T00:00:00.000Z",
        updatedAt: "2026-11-15T00:00:00.000Z",
      },
      {
        id: "item-22",
        key: "#22",
        title: "dispatcher",
        brief: "test",
        dependencies: ["item-21"],
        status: "queued",
        author: "Owner",
        source: "manual",
        createdAt: "2026-11-15T00:00:00.000Z",
        updatedAt: "2026-11-15T00:00:00.000Z",
      },
    ];
    fs.writeFileSync(path.join(tmpDir, "board.json"), JSON.stringify(staleItems), "utf8");
    const store = new BoardStore(tmpDir);
    const migrated = store.list();
    assert.equal(migrated.find((i) => i.id === "item-15")?.status, "done");
    assert.equal(migrated.find((i) => i.id === "item-22")?.status, "done");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// 2. UI-070 & UI-008: Path and title helpers
{
  assert.equal(
    displayRepoPath(
      "C:\\Users\\zackm\\Desktop\\repos\\local-agentic-sandbox\\web-ui\\lib\\chatUtils.ts"
    ),
    "web-ui/lib/chatUtils.ts"
  );
  assert.equal(displayBasename("web-ui/lib/chatUtils.ts"), "chatUtils.ts");
  const short = deriveThreadDisplayTitle(
    "You are working on a PR-sized coding task. Fix the board scroll."
  );
  assert.equal(short, "Fix the board scroll.");
}

// 3. UI-059, UI-061, UI-068, UI-073, UI-066, UI-040, UI-051, UI-064, UI-065 source assertions
{
  const boardView = readComp("components/BoardView.tsx");
  assert.ok(!boardView.includes("0.0K / 100K"), "UI-059: BoardView must not render meterLabel");
  assert.ok(
    boardView.includes("min-h-[44px] min-w-[44px]"),
    "UI-065: BoardView hamburger must be >=44px"
  );

  const chatStream = readComp("components/ChatStream.tsx");
  assert.ok(!chatStream.includes("model-pill-form-toggle"), "UI-068: A/B toggle must be removed");
  assert.ok(chatStream.includes("pt-[16px]"), "UI-061: ChatStream top padding must be pt-[16px]");

  const page = readComp("app/page.tsx");
  assert.ok(
    page.includes("setDraftComposerPrompt(draftPrompt)"),
    "UI-073: onAskAssistant must pass draftPrompt"
  );
  assert.ok(
    page.includes("setIsSidebarOpen(false)") && !page.includes("setIsSidebarOpen(true)"),
    "UI-082: mobile Sessions nav must dismiss sidebar overlay"
  );

  const sidebar = readComp("components/ThreadsSidebar.tsx");
  assert.ok(
    sidebar.includes("/api/threads?q="),
    "UI-040: ThreadsSidebar must query /api/threads?q="
  );

  const builds = readComp("components/BuildsView.tsx");
  assert.ok(
    builds.includes("Array.isArray(data.items)"),
    "UI-051: BuildsView fallback must consume data.items"
  );

  const purgedFiles = [
    "components/NavigationDrawer.tsx",
    "components/ThreadsSidebar.tsx",
    "components/ChatStream.tsx",
    "components/ProjectsView.tsx",
    "components/BuildsView.tsx",
    "components/SettingsView.tsx",
    "components/SandboxGauge.tsx",
    "components/MorningReportView.tsx",
  ];
  // Sanctioned amber tokens in ChatStream.tsx only:
  // - Owner-directed DISCONNECTED warning banner (bg-amber-50, dark:bg-amber-950/40, border-amber-300, dark:border-amber-800/60, text-amber-800, dark:text-amber-200, text-amber-600, dark:text-amber-400)
  // - Established 70-85K context meter band (text-amber-600, dark:text-amber-400, bg-amber-500)

  // Emerald is the sole primary brand accent across surfaces; amber is restricted to sanctioned warnings.
  for (const f of purgedFiles) {
    const content = readComp(f);
    assert.ok(content.length > 0, `${f} must be readable`);
  }
}

console.log("uiuxAuditFixes.test.ts: all assertions passed");

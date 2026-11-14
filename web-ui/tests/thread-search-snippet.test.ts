import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ThreadStore } from "../lib/threads/threadStore";

const webUiRoot = path.resolve(__dirname, "..");

describe("B3: Search match context (matchSnippet)", () => {
  it("listThreadSummaries(query) returns matchSnippet around body-only match", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thread-search-test-"));
    try {
      const store = new ThreadStore(tmpDir);
      const thread = store.createThread("General chat", "swift-15-27b-mtp");
      thread.messages = [
        {
          id: "m1",
          role: "user",
          content: "Please check the database migration for the quantum_flux_capacitor table in production.",
          timestamp: new Date().toISOString(),
        },
      ];
      store.saveThread(thread);

      const summaries = await (store as any).listThreadSummaries("quantum_flux_capacitor");
      const found = summaries.find((s: any) => s.id === thread.id);
      assert.ok(found, "Expected thread matching body-only query");
      assert.ok(
        typeof found.matchSnippet === "string" && found.matchSnippet.toLowerCase().includes("quantum_flux_capacitor"),
        `Expected matchSnippet containing query, got: ${found.matchSnippet}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ThreadsSidebar.tsx and NavigationDrawer.tsx render matchSnippet highlighted under the title", () => {
    const sidebarSrc = fs.readFileSync(path.join(webUiRoot, "components", "ThreadsSidebar.tsx"), "utf8");
    const drawerSrc = fs.readFileSync(path.join(webUiRoot, "components", "NavigationDrawer.tsx"), "utf8");
    assert.ok(sidebarSrc.includes("matchSnippet"), "ThreadsSidebar.tsx must render matchSnippet");
    assert.ok(drawerSrc.includes("matchSnippet"), "NavigationDrawer.tsx must render matchSnippet");
  });
});

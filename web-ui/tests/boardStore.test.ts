import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BoardStore,
  fileBoardItem,
  seedBoardIfEmpty,
  isItemEligible,
  type BoardItem,
} from "../lib/board/boardStore";

describe("BoardStore", () => {
  let tmpDir: string;
  let store: BoardStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-store-test-"));
    store = new BoardStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("supports item CRUD and persists across restarts", () => {
    const created = store.create({
      key: "#99",
      title: "test-item",
      brief: "Verify CRUD persistence",
      dependencies: [],
      author: "Owner",
      source: "manual",
    });

    assert.equal(created.title, "test-item");
    assert.equal(created.status, "queued");
    assert.equal(created.author, "Owner");
    assert.equal(created.source, "manual");
    assert.ok(created.id);

    const fetched = store.get(created.id);
    assert.deepEqual(fetched, created);

    const updated = store.update(created.id, { status: "working" });
    assert.equal(updated.status, "working");

    // Re-instantiate store from same directory to verify persistence
    const reloaded = new BoardStore(tmpDir);
    const list = reloaded.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].status, "working");
  });

  it("enforces dependency gating: eligible only when all dependencies are done", () => {
    const dep1 = store.create({
      key: "#1",
      title: "dep-one",
      brief: "First dependency",
      dependencies: [],
      author: "Owner",
      source: "manual",
    });
    const dep2 = store.create({
      key: "#2",
      title: "dep-two",
      brief: "Second dependency",
      dependencies: [],
      author: "Owner",
      source: "manual",
    });
    const target = store.create({
      key: "#3",
      title: "target-item",
      brief: "Depends on #1 and #2",
      dependencies: [dep1.id, dep2.id],
      author: "Owner",
      source: "assistant",
    });

    assert.equal(isItemEligible(dep1, store.list()), true);
    assert.equal(isItemEligible(target, store.list()), false);

    store.update(dep1.id, { status: "done" });
    assert.equal(isItemEligible(target, store.list()), false);

    store.update(dep2.id, { status: "done" });
    assert.equal(isItemEligible(target, store.list()), true);
  });

  it("requires author 'Owner' and source ('assistant' | 'manual') on create", () => {
    assert.throws(() => {
      store.create({
        key: "#10",
        title: "no-author",
        brief: "Missing author",
        dependencies: [],
        author: "" as "Owner",
        source: "manual",
      });
    }, /author/i);

    assert.throws(() => {
      store.create({
        key: "#11",
        title: "no-source",
        brief: "Missing source",
        dependencies: [],
        author: "Owner",
        source: "" as "manual",
      });
    }, /source/i);

    const filed = fileBoardItem(
      {
        key: "#12",
        title: "via-helper",
        brief: "Filed via fileBoardItem",
        dependencies: [],
        author: "Owner",
        source: "assistant",
      },
      store
    );
    assert.equal(filed.author, "Owner");
    assert.equal(filed.source, "assistant");
    assert.equal(filed.status, "queued");
  });

  it("requires a reason string when parking an item", () => {
    const item = store.create({
      key: "#20",
      title: "parkable",
      brief: "Will be parked",
      dependencies: [],
      author: "Owner",
      source: "manual",
    });

    assert.throws(() => {
      store.update(item.id, { status: "parked", parkedReason: "" });
    }, /reason/i);

    const parked = store.update(item.id, {
      status: "parked",
      parkedReason: "Trigger not met — waits on Qwen 4 weights",
    });
    assert.equal(parked.status, "parked");
    assert.equal(parked.parkedReason, "Trigger not met — waits on Qwen 4 weights");
  });

  it("seeds once when empty, never overwrites existing data, and never invents items", () => {
    const seeded1 = seedBoardIfEmpty(store);
    assert.ok(seeded1.length > 0);
    const countAfterFirst = store.list().length;
    assert.equal(seeded1.length, countAfterFirst);

    // Every seeded item must have author Owner
    for (const item of seeded1) {
      assert.equal(item.author, "Owner");
    }

    // Mutate one item and add a custom item, then run seed again
    store.create({
      key: "#999",
      title: "custom-owner-item",
      brief: "Should not be overwritten",
      dependencies: [],
      author: "Owner",
      source: "manual",
    });

    const seeded2 = seedBoardIfEmpty(store);
    assert.equal(seeded2.length, countAfterFirst + 1);
    assert.ok(seeded2.some((i: BoardItem) => i.title === "custom-owner-item"));
  });

  it("persists optional allowlist when supplied and omits it when absent", () => {
    const withAllowlist = store.create({
      key: "#50",
      title: "scoped-item",
      brief: "Has explicit file allowlist",
      dependencies: [],
      allowlist: ["web-ui/lib/board/boardStore.ts", "web-ui/tests/boardStore.test.ts"],
      author: "Owner",
      source: "manual",
    });

    assert.deepEqual(withAllowlist.allowlist, [
      "web-ui/lib/board/boardStore.ts",
      "web-ui/tests/boardStore.test.ts",
    ]);

    const withoutAllowlist = store.create({
      key: "#51",
      title: "unscoped-item",
      brief: "No allowlist supplied",
      dependencies: [],
      author: "Owner",
      source: "manual",
    });

    assert.equal("allowlist" in withoutAllowlist, false);
    assert.equal(withoutAllowlist.allowlist, undefined);

    const reloaded = new BoardStore(tmpDir);
    assert.deepEqual(reloaded.get(withAllowlist.id)?.allowlist, [
      "web-ui/lib/board/boardStore.ts",
      "web-ui/tests/boardStore.test.ts",
    ]);
    assert.equal("allowlist" in (reloaded.get(withoutAllowlist.id) ?? {}), false);
  });

  it("allocates new keys one past the maximum existing numeric key without colliding after gaps", () => {
    store.create({
      key: "#1",
      title: "first",
      brief: "Item 1",
      author: "Owner",
      source: "manual",
    });
    store.create({
      key: "#15",
      title: "fifteenth",
      brief: "Item 15 (simulating gaps from deletions)",
      author: "Owner",
      source: "manual",
    });
    store.create({
      key: "CUSTOM-X",
      title: "custom",
      brief: "Non-numeric key",
      author: "Owner",
      source: "manual",
    });

    const autoNext = store.create({
      title: "auto-allocated",
      brief: "Should be #16, not #4",
      author: "Owner",
      source: "manual",
    });
    assert.equal(autoNext.key, "#16");

    const explicit = store.create({
      key: "#42",
      title: "explicit-key",
      brief: "Explicit key respected",
      author: "Owner",
      source: "manual",
    });
    assert.equal(explicit.key, "#42");

    const afterExplicit = store.create({
      title: "after-explicit",
      brief: "Should be #43",
      author: "Owner",
      source: "manual",
    });
    assert.equal(afterExplicit.key, "#43");
  });

  it("R7: new BoardStore() preserves existing board.meta.json control.state during migration", () => {
    const metaDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-meta-preserve-"));
    try {
      const boardPath = path.join(metaDir, "board.json");
      const metaPath = path.join(metaDir, "board.meta.json");
      fs.writeFileSync(
        boardPath,
        JSON.stringify([
          {
            id: "item-meta-1",
            key: "#1",
            title: "Existing item",
            brief: "Brief",
            dependencies: [],
            status: "queued",
            author: "Owner",
            source: "manual",
            createdAt: "2026-11-20T00:00:00.000Z",
            updatedAt: "2026-11-20T00:00:00.000Z",
          },
        ]),
        "utf8"
      );
      fs.writeFileSync(
        metaPath,
        JSON.stringify(
          {
            control: {
              state: "running",
              drainBudget: 5,
              stopAtBoundary: false,
              updatedAt: "2026-11-23T00:00:00.000Z",
              lastAction: "start",
            },
          },
          null,
          2
        ),
        "utf8"
      );

      new BoardStore(metaDir);
      const afterMeta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
        version?: number;
        control?: { state?: string; drainBudget?: number | null };
      };
      assert.equal(afterMeta.version, 2);
      assert.equal(afterMeta.control?.state, "running");
      assert.equal(afterMeta.control?.drainBudget, 5);
    } finally {
      fs.rmSync(metaDir, { recursive: true, force: true });
    }
  });

  it("R8: BoardStore.update supports null deletion, clears needsAttention/parkedReason on done/working/queued transitions, and persists evidence", () => {
    const item = store.create({
      key: "#77",
      title: "Clearable flags",
      brief: "Test flag clearing and evidence",
      dependencies: [],
      status: "needs-attention",
      needsAttention: true,
      parkedReason: "Stalled earlier",
      autoResumeCount: 2,
      author: "Owner",
      source: "manual",
    });

    // Explicit null deletes needsAttention, parkedReason, autoResumeCount
    const clearedNull = store.update(item.id, {
      needsAttention: null,
      parkedReason: null,
      autoResumeCount: null,
    });
    assert.equal("needsAttention" in clearedNull, false);
    assert.equal("parkedReason" in clearedNull, false);
    assert.equal("autoResumeCount" in clearedNull, false);

    // Re-set failure flags, then transition to done/working/queued and confirm auto-clear
    for (const targetStatus of ["done", "working", "queued"] as const) {
      store.update(item.id, {
        status: "needs-attention",
        needsAttention: true,
        parkedReason: "Failure reason",
      });
      const transitioned = store.update(item.id, {
        status: targetStatus,
        ...(targetStatus === "done"
          ? { evidence: { prNumber: 245, mergeSha: "abc1234", deployTag: "v245" } }
          : {}),
      });
      assert.equal(transitioned.status, targetStatus);
      assert.equal(
        transitioned.needsAttention,
        undefined,
        `needsAttention must clear on transition to ${targetStatus}`
      );
      assert.equal(
        transitioned.parkedReason,
        undefined,
        `parkedReason must clear on transition to ${targetStatus}`
      );
      if (targetStatus === "done") {
        assert.deepEqual(transitioned.evidence, {
          prNumber: 245,
          mergeSha: "abc1234",
          deployTag: "v245",
        });
      }
    }
  });

  it("R8: PATCH /api/board rejects invalid status values with HTTP 400", async () => {
    const prevBoardDir = process.env.BOARD_DIR;
    process.env.BOARD_DIR = tmpDir;
    try {
      const item = store.create({
        key: "#88",
        title: "Status validation",
        brief: "Validate PATCH status",
        dependencies: [],
        author: "Owner",
        source: "manual",
      });

      const { PATCH } = await import("../app/api/board/route");
      const { NextRequest } = await import("next/server");
      const req = new NextRequest("http://localhost/api/board", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: item.id, status: "not-a-valid-status" }),
      });
      const res = await PATCH(req);
      assert.equal(res.status, 400);
      assert.equal(store.get(item.id)?.status, "queued");
    } finally {
      if (prevBoardDir === undefined) delete process.env.BOARD_DIR;
      else process.env.BOARD_DIR = prevBoardDir;
    }
  });
});

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
});

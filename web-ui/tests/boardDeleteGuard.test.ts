import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";

import { BoardStore, type BoardItem } from "../lib/board/boardStore";
import { BoardView } from "../components/BoardView";
import { DELETE as deleteBoard } from "../app/api/board/route";

async function flushEffects(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function makeItem(overrides: Partial<BoardItem>): BoardItem {
  return {
    id: "item-x",
    key: "#124",
    title: "delete-guard-item",
    brief: "Board item delete guard.",
    dependencies: [],
    status: "queued",
    author: "Owner",
    source: "manual",
    createdAt: "2026-11-25T00:00:00Z",
    updatedAt: "2026-11-25T00:00:00Z",
    ...overrides,
  };
}

describe("Board item delete guard — store", () => {
  it("BoardStore.remove refuses to remove a working item and leaves it on disk", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-delete-guard-store-"));
    const prevBoardDir = process.env.BOARD_DIR;
    process.env.BOARD_DIR = tmpDir;
    try {
      const store = new BoardStore(tmpDir);
      const working = store.create({
        key: "#124W",
        title: "working-item",
        brief: "Currently running a job.",
        dependencies: [],
        author: "Owner",
        source: "manual",
        status: "working",
      });
      assert.throws(
        () => store.remove(working.id),
        /working/i,
        "remove must refuse for a working item"
      );
      const reloaded = new BoardStore(tmpDir);
      assert.ok(reloaded.get(working.id), "Working item must remain on disk after refused remove");
    } finally {
      if (prevBoardDir === undefined) delete process.env.BOARD_DIR;
      else process.env.BOARD_DIR = prevBoardDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("BoardStore.remove still removes non-working items and throws not-found", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-delete-guard-store-ok-"));
    const prevBoardDir = process.env.BOARD_DIR;
    process.env.BOARD_DIR = tmpDir;
    try {
      const store = new BoardStore(tmpDir);
      const queued = store.create({
        key: "#124Q",
        title: "queued-item",
        brief: "Not running.",
        dependencies: [],
        author: "Owner",
        source: "manual",
      });
      const removed = store.remove(queued.id);
      assert.equal(removed.id, queued.id);
      assert.equal(new BoardStore(tmpDir).get(queued.id), undefined);
      assert.throws(() => store.remove("missing-id"), /not found/i);
    } finally {
      if (prevBoardDir === undefined) delete process.env.BOARD_DIR;
      else process.env.BOARD_DIR = prevBoardDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Board item delete guard — DELETE route", () => {
  it("DELETE /api/board returns 409 for a working item and the item survives", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-delete-guard-route-409-"));
    const prevBoardDir = process.env.BOARD_DIR;
    process.env.BOARD_DIR = tmpDir;
    try {
      const store = new BoardStore(tmpDir);
      const item = store.create({
        key: "#124W",
        title: "working-item",
        brief: "Currently running a job.",
        dependencies: [],
        author: "Owner",
        source: "manual",
        status: "working",
      });
      const res = await deleteBoard(
        new NextRequest(`http://localhost/api/board?id=${encodeURIComponent(item.id)}`, {
          method: "DELETE",
        })
      );
      assert.equal(res.status, 409, "Working item DELETE must return 409");
      const body = await res.json();
      assert.match(String(body.error), /working/i, "409 body must state the working-item reason");
      assert.ok(
        new BoardStore(tmpDir).get(item.id),
        "Working item must not be deleted out from under its run"
      );
    } finally {
      if (prevBoardDir === undefined) delete process.env.BOARD_DIR;
      else process.env.BOARD_DIR = prevBoardDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("DELETE /api/board keeps 200 for removable items and 404 for unknown ids", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-delete-guard-route-200-"));
    const prevBoardDir = process.env.BOARD_DIR;
    process.env.BOARD_DIR = tmpDir;
    try {
      const store = new BoardStore(tmpDir);
      const item = store.create({
        key: "#124D",
        title: "done-item",
        brief: "Landed.",
        dependencies: [],
        author: "Owner",
        source: "manual",
        status: "done",
      });
      const ok = await deleteBoard(
        new NextRequest(`http://localhost/api/board?id=${encodeURIComponent(item.id)}`, {
          method: "DELETE",
        })
      );
      assert.equal(ok.status, 200);
      assert.equal(new BoardStore(tmpDir).get(item.id), undefined);

      const missing = await deleteBoard(
        new NextRequest("http://localhost/api/board?id=nope-404", { method: "DELETE" })
      );
      assert.equal(missing.status, 404);
    } finally {
      if (prevBoardDir === undefined) delete process.env.BOARD_DIR;
      else process.env.BOARD_DIR = prevBoardDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Board item delete UI — inline confirmation", () => {
  it("clicking Delete does not send DELETE until Confirm Delete is clicked", async () => {
    const win = new GlobalWindow({ url: "http://localhost:3000" });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.window = win as unknown as Window & typeof globalThis;
    globalThis.document = win.document as unknown as Document;
    const container = win.document.createElement("div") as unknown as HTMLDivElement;
    win.document.body.appendChild(
      container as unknown as Parameters<typeof win.document.body.appendChild>[0]
    );
    const root = createRoot(container);

    const calls: Array<{ url: string; method: string }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method || "GET" });
      return new Response(JSON.stringify({ success: true, removed: makeItem({}) }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    try {
      await act(async () => {
        root.render(
          React.createElement(BoardView, {
            items: [makeItem({ id: "item-done", status: "done" })],
            onOpenDrawer: () => {},
            onItemCreated: () => {},
            onAskAssistant: () => {},
          })
        );
      });
      await flushEffects();

      const deleteBtn = container.querySelector(
        '[data-testid="board-delete-item-done"]'
      ) as HTMLButtonElement | null;
      assert.ok(deleteBtn, "Delete button must exist on cards");

      await act(async () => {
        deleteBtn.click();
      });
      await flushEffects();

      assert.equal(
        calls.filter((c) => c.method === "DELETE").length,
        0,
        "Clicking Delete must not send DELETE before confirmation"
      );

      const confirmText = container.textContent || "";
      assert.match(
        confirmText,
        /permanently removed/i,
        "Confirmation step must state the item is permanently removed"
      );
      assert.match(
        confirmText,
        /cannot be undone/i,
        "Confirmation step must state the removal cannot be undone"
      );

      const cancelBtn = container.querySelector(
        '[data-testid="board-delete-cancel-item-done"]'
      ) as HTMLButtonElement | null;
      assert.ok(cancelBtn, "Confirmation step must provide a cancel button");
      await act(async () => {
        cancelBtn.click();
      });
      await flushEffects();
      assert.equal(
        calls.filter((c) => c.method === "DELETE").length,
        0,
        "Cancel must not send DELETE"
      );

      await act(async () => {
        const deleteBtnAgain = container.querySelector(
          '[data-testid="board-delete-item-done"]'
        ) as HTMLButtonElement | null;
        assert.ok(deleteBtnAgain, "Delete button must return after cancel");
        deleteBtnAgain.click();
      });
      await flushEffects();
      const confirmBtn = container.querySelector(
        '[data-testid="board-delete-confirm-item-done"]'
      ) as HTMLButtonElement | null;
      assert.ok(confirmBtn, "Confirmation step must provide a confirm button");
      await act(async () => {
        confirmBtn.click();
      });
      await flushEffects();
      assert.ok(
        calls.some(
          (c) => c.method === "DELETE" && c.url.includes("/api/board") && c.url.includes("item-done")
        ),
        "Confirming must send DELETE for the item"
      );
    } finally {
      act(() => root.unmount());
      globalThis.fetch = origFetch;
      delete (globalThis as Record<string, unknown>).window;
      delete (globalThis as Record<string, unknown>).document;
      win.close();
    }
  });

  it("a working item shows delete as unavailable with the reason", () => {
    const html = renderToStaticMarkup(
      React.createElement(BoardView, {
        items: [makeItem({ id: "item-live", status: "working" })],
        onOpenDrawer: () => {},
        onItemCreated: () => {},
        onAskAssistant: () => {},
      })
    );
    assert.match(
      html,
      /data-testid="board-delete-item-live"[^>]*disabled/,
      "Working-item delete must be disabled (unavailable)"
    );
    assert.match(html, /job is running/i, "Working-item delete must state the reason");
  });
});

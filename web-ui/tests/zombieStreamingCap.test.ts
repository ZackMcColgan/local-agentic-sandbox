import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ThreadStore,
  activeExecutionSet,
  markTurnActive,
  clearTurnActive,
  getActiveTurn,
  isZombiePresence,
  ZOMBIE_TURN_AGE_CAP_MS,
  TURN_STALL_WINDOW_MS
} from "../lib/threads/threadStore";
import type { Thread } from "../lib/threads/threadStore";

function makeStore(): { store: ThreadStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zombie-cap-test-"));
  return { store: new ThreadStore(dir), dir };
}

function rewindUpdatedAt(dir: string, threadId: string, ageMs: number): void {
  const file = path.join(dir, `${threadId}.json`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.updatedAt = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
}

function seedStreamingThread(store: ThreadStore, id: string): Thread {
  const thread = store.createThread({ id, title: "zombie candidate" });
  store.addMessage(id, {
    id: `${id}-msg`,
    role: "assistant",
    content: "partial work",
    status: "streaming",
    timestamp: new Date().toISOString()
  });
  return thread;
}

/**
 * qa-6 / UI-001 + UI-002: a leaked turn-presence entry (or a leaked
 * execution-set entry) must not keep a dead turn "live" forever. The
 * reconcile path gains a hard cap: a live signal whose thread record has
 * been untouched past the cap is a zombie and gets reconciled to
 * incomplete/stopped like any other dead turn. A genuinely live long
 * turn is protected by its heartbeat — its record stays fresh.
 */
describe("qa-6 — zombie streaming cap (UI-001/UI-002)", () => {
  it("cap constant is finite and far beyond any single round", () => {
    assert.ok(Number.isFinite(ZOMBIE_TURN_AGE_CAP_MS));
    assert.ok(ZOMBIE_TURN_AGE_CAP_MS >= 60 * 60 * 1000, "cap must be at least an hour");
  });

  it("isZombiePresence: ancient presence + stale record is a zombie", () => {
    const now = Date.now();
    const thread = { updatedAt: new Date(now - TURN_STALL_WINDOW_MS - 60000).toISOString() } as Thread;
    const presence = { threadId: "t", startedAt: new Date(now - ZOMBIE_TURN_AGE_CAP_MS - 60000).toISOString(), status: "streaming" as const };
    assert.equal(isZombiePresence(presence, thread, now), true);
  });

  it("isZombiePresence: ancient presence + fresh record is NOT a zombie (live long turn)", () => {
    const now = Date.now();
    const thread = { updatedAt: new Date(now - 30000).toISOString() } as Thread;
    const presence = { threadId: "t", startedAt: new Date(now - ZOMBIE_TURN_AGE_CAP_MS - 60000).toISOString(), status: "streaming" as const };
    assert.equal(isZombiePresence(presence, thread, now), false);
  });

  it("isZombiePresence: young presence + stale record is NOT a zombie", () => {
    const now = Date.now();
    const thread = { updatedAt: new Date(now - TURN_STALL_WINDOW_MS - 60000).toISOString() } as Thread;
    const presence = { threadId: "t", startedAt: new Date(now - 60000).toISOString(), status: "streaming" as const };
    assert.equal(isZombiePresence(presence, thread, now), false);
  });

  it("reconcile reaps a zombie: leaked presence, record stale past the cap", async () => {
    const { store, dir } = makeStore();
    const thread = seedStreamingThread(store, "t-zombie");
    // Leaked presence registered 7h ago; record untouched for 7h.
    markTurnActive(thread.id, new Date(Date.now() - ZOMBIE_TURN_AGE_CAP_MS - 3600000).toISOString());
    rewindUpdatedAt(dir, thread.id, ZOMBIE_TURN_AGE_CAP_MS + 3600000);

    const after = await store.getThread(thread.id);
    assert.ok(after);
    assert.notEqual(after.status, "active", "zombie thread must not stay active");
    const msg = after.messages.find((m) => m.id === "t-zombie-msg");
    assert.ok(msg);
    assert.equal(msg.status, "incomplete", "zombie streaming message must finalize as incomplete");
    assert.equal(getActiveTurn(thread.id), null, "zombie presence entry must be reaped");
    clearTurnActive(thread.id);
  });

  it("reconcile keeps a live long turn: ancient presence but fresh record", async () => {
    const { store } = makeStore();
    const thread = seedStreamingThread(store, "t-longlive");
    markTurnActive(thread.id, new Date(Date.now() - ZOMBIE_TURN_AGE_CAP_MS - 3600000).toISOString());
    // record stays fresh (heartbeat) — no rewind.

    const after = await store.getThread(thread.id);
    assert.ok(after);
    const msg = after.messages.find((m) => m.id === "t-longlive-msg");
    assert.ok(msg);
    assert.equal(msg.status, "streaming", "live long turn must not be reaped");
    clearTurnActive(thread.id);
  });

  it("reconcile reaps a leaked execution-set entry when the record is stale past the cap", async () => {
    const { store, dir } = makeStore();
    const thread = seedStreamingThread(store, "t-execleak");
    activeExecutionSet.add(thread.id);
    rewindUpdatedAt(dir, thread.id, ZOMBIE_TURN_AGE_CAP_MS + 3600000);

    const after = await store.getThread(thread.id);
    assert.ok(after);
    const msg = after.messages.find((m) => m.id === "t-execleak-msg");
    assert.ok(msg);
    assert.equal(msg.status, "incomplete", "dead execution leak must finalize as incomplete");
    activeExecutionSet.delete(thread.id);
  });

  it("reconcile leaves a normal live turn untouched", async () => {
    const { store } = makeStore();
    const thread = seedStreamingThread(store, "t-normal");
    activeExecutionSet.add(thread.id);
    markTurnActive(thread.id);

    const after = await store.getThread(thread.id);
    assert.ok(after);
    const msg = after.messages.find((m) => m.id === "t-normal-msg");
    assert.ok(msg);
    assert.equal(msg.status, "streaming");
    activeExecutionSet.delete(thread.id);
    clearTurnActive(thread.id);
  });
});

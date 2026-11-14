import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ThreadStore, deriveThreadTitle } from "../lib/threads/threadStore";

describe("UI-008 readable thread-list titles (record-side derivation)", () => {
  let tmpDir: string;
  let store: ThreadStore;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `test-title-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    store = new ThreadStore(tmpDir);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe("deriveThreadTitle (pure)", () => {
    it("strips the 'JOB — ' driver prefix and keeps the readable goal", () => {
      const title = deriveThreadTitle(
        "JOB — ui-qa-sweep (findings-only, docs-only sweep of the whole UI surface)"
      );
      assert.ok(!title.startsWith("JOB"), `title still carries JOB prefix: ${title}`);
      assert.ok(title.startsWith("ui-qa-sweep"), `expected goal-first title: ${title}`);
      assert.ok(title.length <= 40, `title exceeds 40 chars: ${title.length}`);
    });

    it("strips stacked 'Session: ' and 'JOB — ' prefixes", () => {
      const title = deriveThreadTitle(
        "Session: JOB — qa-2: readable thread-list titles (UI-008, from findings doc)"
      );
      assert.ok(!title.startsWith("Session"), `title still carries Session prefix: ${title}`);
      assert.ok(!title.startsWith("JOB"), `title still carries JOB prefix: ${title}`);
      assert.ok(title.startsWith("qa-2:"), `expected goal-first title: ${title}`);
    });

    it("never cuts mid-word when truncating", () => {
      const goal =
        "JOB — implement the progressive tool registry rollout across all three tiers carefully";
      const title = deriveThreadTitle(goal);
      assert.ok(title.length <= 40, `title exceeds 40 chars: ${title.length}`);
      // Word-boundary check: locate the title inside the source goal. If the
      // source continues past the title, the very next source character must
      // be whitespace (never a continuation of a word).
      const idx = goal.indexOf(title);
      assert.ok(idx >= 0, `title is not a substring of the goal: ${title}`);
      if (idx + title.length < goal.length) {
        assert.ok(/\s/.test(goal[idx + title.length]),
          `title ends mid-word: ${title} (next source char: '${goal[idx + title.length]}')`);
      }
      assert.ok(!title.endsWith("-"), `title ends on a dangling hyphen: ${title}`);
    });

    it("uses the first line of a multi-line goal", () => {
      const title = deriveThreadTitle(
        "Fix the sidebar contrast tokens\n\nPROTOCOL: many lines of standing protocol text here"
      );
      assert.equal(title, "Fix the sidebar contrast tokens");
    });

    it("short plain goals pass through unchanged", () => {
      assert.equal(deriveThreadTitle("Fix the login button"), "Fix the login button");
    });

    it("plain goals do not gain a prefix or ellipsis", () => {
      const goal = "A plain goal that is longer than forty characters in total length";
      const title = deriveThreadTitle(goal);
      assert.ok(!title.includes("…"), `title carries ellipsis: ${title}`);
      assert.ok(title.startsWith("A plain goal"), `unexpected title: ${title}`);
    });

    it("empty or whitespace goals fall back to 'New thread'", () => {
      assert.equal(deriveThreadTitle(""), "New thread");
      assert.equal(deriveThreadTitle("   "), "New thread");
      assert.equal(deriveThreadTitle(undefined), "New thread");
      assert.equal(deriveThreadTitle("JOB — "), "New thread");
    });

    it("does not strip ordinary words that merely start with 'job' or 'session'", () => {
      assert.equal(deriveThreadTitle("Job board app for hiring listings"), "Job board app for hiring listings");
      assert.equal(deriveThreadTitle("Sessions table migration for auth"), "Sessions table migration for auth");
    });
  });

  describe("ThreadStore.createThread uses derived titles", () => {
    it("createThread from a JOB-style initialPrompt yields a readable title", () => {
      const thread = store.createThread({
        initialPrompt: "JOB — ui-qa-sweep (findings-only, docs-only sweep of the whole UI surface)"
      });
      assert.ok(!thread.title.startsWith("JOB"), `title still carries JOB prefix: ${thread.title}`);
      assert.ok(!thread.title.startsWith("Session"), `title still carries Session prefix: ${thread.title}`);
      assert.ok(thread.title.startsWith("ui-qa-sweep"), `unexpected title: ${thread.title}`);
      assert.ok(thread.title.length <= 40, `title exceeds 40 chars: ${thread.title.length}`);
    });

    it("explicit params.title still wins (existing behavior unchanged)", () => {
      const thread = store.createThread({
        title: "My hand-named thread",
        initialPrompt: "JOB — some driver goal that should not become the title"
      });
      assert.equal(thread.title, "My hand-named thread");
    });

    it("createThread with no prompt yields 'New thread' (existing behavior unchanged)", () => {
      const thread = store.createThread({});
      assert.equal(thread.title, "New thread");
    });
  });

  describe("Lane A Item 1: full first-line storage & additive re-derivation", () => {
    it("addMessage stores the full first line of a long first user message without mid-word cut", async () => {
      const thread = store.createThread({ title: "New thread" });
      const longFirstLine =
        "Investigate why the authentication middleware rejects valid refresh tokens";
      store.addMessage(thread.id, {
        id: "msg-1",
        role: "user",
        content: `${longFirstLine}\n\nSecond paragraph with extra details.`,
        createdAt: new Date().toISOString()
      });
      const loaded = await store.getThread(thread.id);
      assert.equal(loaded?.title, longFirstLine);
    });

    it("getThread re-derives a title already stored in chopped form from its first user message", async () => {
      const longFirstLine =
        "Investigate why the authentication middleware rejects valid refresh tokens";
      // Simulate a legacy thread whose title was chopped mid-word at 40 chars
      const chopped = longFirstLine.slice(0, 40);
      const thread = store.createThread({ title: chopped });
      // Write message directly to disk to bypass addMessage
      const filePath = path.join(tmpDir, `${thread.id}.json`);
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      raw.messages = [
        {
          id: "msg-1",
          role: "user",
          content: longFirstLine,
          createdAt: new Date().toISOString()
        }
      ];
      fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));

      const loaded = await store.getThread(thread.id);
      assert.equal(loaded?.title, longFirstLine);
    });

    it("task thread created from 'JOB — <long goal>' ends up with full first-line title after getThread, not a 36-char chop", async () => {
      const longGoal = "audit the entire authentication and session lifecycle end to end";
      const prompt = `JOB — ${longGoal}\n\nExtra details on line two.`;
      const thread = store.createThread({
        initialPrompt: prompt,
        taskId: "task-job-1"
      });
      const loaded = await store.getThread(thread.id);
      assert.equal(loaded?.title, longGoal);
      assert.ok((loaded?.title.length ?? 0) > 36, "title should not be chopped to 36 chars");
    });
  });
});


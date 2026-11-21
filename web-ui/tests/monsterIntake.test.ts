import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BoardStore } from "../lib/board/boardStore";
import { BoardControlStore } from "../lib/board/boardControlStore";
import { PrioritySlotScheduler, SlotPriority } from "../lib/slotScheduler";
import type { GenerateFn, GenerateRequest } from "../lib/subagents/llmClient";
import {
  validateIntakeStack,
  previewMonsterIntake,
  confirmMonsterIntake,
  repairAndParseIntakeJson,
  IntakeValidationError,
  IntakeModelError,
  type IntakeStackItem,
} from "../lib/board/monsterIntake";

function makeTempBoardDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "monster-intake-test-"));
}

test("1. Valid stack schema passes validation; missing acceptanceCriteria, fileAllowlist, or empty title/brief are rejected with specific reason", () => {
  const validStack: IntakeStackItem[] = [
    {
      tempKey: "S1",
      title: "Add intake parser",
      brief: "Parse structured JSON output from the intake model call.",
      dependencies: [],
      fileAllowlist: ["web-ui/lib/board/monsterIntake.ts"],
      acceptanceCriteria: ["Parses valid JSON stack", "Rejects malformed payloads"],
    },
  ];

  const validated = validateIntakeStack(validStack, []);
  assert.equal(validated.length, 1);
  assert.equal(validated[0].title, "Add intake parser");

  // Missing acceptanceCriteria
  assert.throws(
    () =>
      validateIntakeStack(
        [
          {
            title: "Item A",
            brief: "Do A",
            dependencies: [],
            fileAllowlist: ["a.ts"],
            acceptanceCriteria: [],
          },
        ],
        []
      ),
    (err: unknown) => {
      assert.ok(err instanceof IntakeValidationError);
      assert.match(err.message, /acceptanceCriteria/i);
      return true;
    }
  );

  // Missing fileAllowlist
  assert.throws(
    () =>
      validateIntakeStack(
        [
          {
            title: "Item B",
            brief: "Do B",
            dependencies: [],
            fileAllowlist: [],
            acceptanceCriteria: ["Works"],
          },
        ],
        []
      ),
    (err: unknown) => {
      assert.ok(err instanceof IntakeValidationError);
      assert.match(err.message, /fileAllowlist/i);
      return true;
    }
  );

  // Empty title
  assert.throws(
    () =>
      validateIntakeStack(
        [
          {
            title: "   ",
            brief: "Do C",
            dependencies: [],
            fileAllowlist: ["c.ts"],
            acceptanceCriteria: ["Works"],
          },
        ],
        []
      ),
    (err: unknown) => {
      assert.ok(err instanceof IntakeValidationError);
      assert.match(err.message, /title/i);
      return true;
    }
  );

  // Empty brief
  assert.throws(
    () =>
      validateIntakeStack(
        [
          {
            title: "Item D",
            brief: "",
            dependencies: [],
            fileAllowlist: ["d.ts"],
            acceptanceCriteria: ["Works"],
          },
        ],
        []
      ),
    (err: unknown) => {
      assert.ok(err instanceof IntakeValidationError);
      assert.match(err.message, /brief/i);
      return true;
    }
  );
});

test("2. Cyclic dependencies and dependencies on unknown keys are rejected", () => {
  // Unknown key
  assert.throws(
    () =>
      validateIntakeStack(
        [
          {
            tempKey: "S1",
            title: "Task 1",
            brief: "Depends on ghost",
            dependencies: ["#999"],
            fileAllowlist: ["a.ts"],
            acceptanceCriteria: ["Done"],
          },
        ],
        []
      ),
    (err: unknown) => {
      assert.ok(err instanceof IntakeValidationError);
      assert.match(err.message, /unknown dependency/i);
      return true;
    }
  );

  // Cyclic dependency (S1 -> S2 -> S1)
  assert.throws(
    () =>
      validateIntakeStack(
        [
          {
            tempKey: "S1",
            title: "Task 1",
            brief: "Needs S2",
            dependencies: ["S2"],
            fileAllowlist: ["a.ts"],
            acceptanceCriteria: ["Done"],
          },
          {
            tempKey: "S2",
            title: "Task 2",
            brief: "Needs S1",
            dependencies: ["S1"],
            fileAllowlist: ["b.ts"],
            acceptanceCriteria: ["Done"],
          },
        ],
        []
      ),
    (err: unknown) => {
      assert.ok(err instanceof IntakeValidationError);
      assert.match(err.message, /cyclic/i);
      return true;
    }
  );
});

test("3. Preview performs ZERO writes to the board store (byte-identical before/after)", async () => {
  const dir = makeTempBoardDir();
  const store = new BoardStore(dir);
  store.create({
    key: "#1",
    title: "Existing item",
    brief: "Already on board",
    author: "Owner",
    source: "manual",
  });

  const boardJsonPath = path.join(dir, "board.json");
  const beforeBytes = fs.readFileSync(boardJsonPath);

  const scheduler = new PrioritySlotScheduler();
  let capturedPriority: SlotPriority | undefined;
  let capturedReq: GenerateRequest | undefined;

  const origRunWithSlot = scheduler.runWithSlot.bind(scheduler);
  scheduler.runWithSlot = ((opts, fn) => {
    capturedPriority = opts.priority;
    return origRunWithSlot(opts, fn);
  }) as typeof scheduler.runWithSlot;

  const generateFn: GenerateFn = async (req) => {
    capturedReq = req;
    return {
      model: req.model,
      text: JSON.stringify({
        items: [
          {
            tempKey: "S1",
            title: "New previewed item",
            brief: "Builds on #1",
            dependencies: ["#1"],
            fileAllowlist: ["web-ui/lib/board/monsterIntake.ts"],
            acceptanceCriteria: ["Previewed without writing"],
          },
        ],
      }),
    };
  };

  const result = await previewMonsterIntake(
    { prompt: "Build a new feature on top of #1" },
    { store, scheduler, generateFn }
  );

  assert.equal(result.items.length, 1);
  assert.equal(capturedPriority, SlotPriority.P2_ORCHESTRATOR);
  assert.equal(capturedReq?.reasoningEffort, "low");
  assert.equal(capturedReq?.options?.num_predict, 4096);

  const afterBytes = fs.readFileSync(boardJsonPath);
  assert.equal(Buffer.compare(beforeBytes, afterBytes), 0, "board.json must be byte-identical after preview");
});

test("4. Confirm files exactly N items atomically with author Owner, source assistant, status queued, and linked dependencies", async () => {
  const dir = makeTempBoardDir();
  const store = new BoardStore(dir);
  const controlStore = new BoardControlStore(dir);

  const existing = store.create({
    key: "#10",
    title: "Base infra",
    brief: "Existing base",
    author: "Owner",
    source: "manual",
  });

  const stack: IntakeStackItem[] = [
    {
      tempKey: "S1",
      title: "Backend intake module",
      brief: "Implement monsterIntake.ts",
      dependencies: ["#10"],
      fileAllowlist: ["web-ui/lib/board/monsterIntake.ts"],
      acceptanceCriteria: ["Unit tests pass"],
    },
    {
      tempKey: "S2",
      title: "UI intake preview",
      brief: "Wire BoardAddSheet preview and confirm",
      dependencies: ["S1"],
      fileAllowlist: ["web-ui/components/BoardAddSheet.tsx"],
      acceptanceCriteria: ["Mobile preview renders"],
    },
  ];

  // Confirm & Start Drain
  const res = await confirmMonsterIntake(
    { items: stack, startDrain: true },
    { store, controlStore }
  );

  assert.equal(res.items.length, 2);
  assert.equal(res.items[0].author, "Owner");
  assert.equal(res.items[0].source, "assistant");
  assert.equal(res.items[0].status, "queued");
  assert.deepEqual(res.items[0].dependencies, [existing.id]);
  assert.deepEqual(res.items[0].allowlist, ["web-ui/lib/board/monsterIntake.ts"]);

  assert.equal(res.items[1].author, "Owner");
  assert.equal(res.items[1].source, "assistant");
  assert.equal(res.items[1].status, "queued");
  assert.deepEqual(res.items[1].dependencies, [res.items[0].id]);
  assert.deepEqual(res.items[1].allowlist, ["web-ui/components/BoardAddSheet.tsx"]);

  assert.equal(res.control?.state, "running");
  assert.equal(controlStore.getState().state, "running");

  // Atomicity: if one item in a batch fails validation, NONE are filed
  const countBefore = store.list().length;
  await assert.rejects(
    () =>
      confirmMonsterIntake(
        {
          items: [
            {
              tempKey: "OK1",
              title: "Valid item",
              brief: "Valid brief",
              dependencies: [],
              fileAllowlist: ["a.ts"],
              acceptanceCriteria: ["Passes"],
            },
            {
              tempKey: "BAD2",
              title: "Invalid item",
              brief: "Missing criteria",
              dependencies: [],
              fileAllowlist: ["b.ts"],
              acceptanceCriteria: [],
            },
          ],
        },
        { store, controlStore }
      ),
    IntakeValidationError
  );
  assert.equal(store.list().length, countBefore, "Zero items must be filed when any item fails validation");
});

test("5. Exactly ONE model call per intake: malformed model response produces clean error, NO second call, NO board writes", async () => {
  const dir = makeTempBoardDir();
  const store = new BoardStore(dir);
  const scheduler = new PrioritySlotScheduler();

  let callCount = 0;
  const generateFn: GenerateFn = async (req) => {
    callCount++;
    return {
      model: req.model,
      text: "Sorry, I cannot output JSON right now — here is some prose instead.",
    };
  };

  await assert.rejects(
    () =>
      previewMonsterIntake(
        { prompt: "Decompose this into tasks" },
        { store, scheduler, generateFn }
      ),
    IntakeModelError
  );

  assert.equal(callCount, 1, "Must make exactly ONE model call with no retry loop");
  assert.equal(store.list().length, 0, "Must perform zero board writes on malformed output");
});

test("6. 1,500-word multi-item prompt fixture decomposes without truncation breaking validation", async () => {
  const dir = makeTempBoardDir();
  const store = new BoardStore(dir);
  const scheduler = new PrioritySlotScheduler();

  // Build a realistic ~1,500-word monster prompt
  const paragraph =
    "We need to modernize the board intake pipeline so the owner can paste a large multi-feature specification " +
    "from a mobile device and get a strictly validated, dependency-ordered stack of queued board items in a single " +
    "bounded orchestrator model call. Each item must include a clear title, actionable brief, explicit file allowlist, " +
    "and verifiable acceptance criteria without mutating the board store until the owner taps confirm. ";
  const monsterPrompt = Array.from({ length: 28 }, (_, i) => `Section ${i + 1}: ${paragraph}`).join("\n");
  const wordCount = monsterPrompt.trim().split(/\s+/).length;
  assert.ok(wordCount >= 1500, `Expected >= 1500 words, got ${wordCount}`);

  // Simulate a slightly truncated JSON response at the tail (missing closing brackets/braces)
  const truncatedJson = `{
    "items": [
      {
        "tempKey": "M1",
        "title": "Schema validator and dependency graph checker",
        "brief": "Validate stack items, reject missing allowlist or criteria, reject unknown or cyclic deps.",
        "dependencies": [],
        "fileAllowlist": ["web-ui/lib/board/monsterIntake.ts"],
        "acceptanceCriteria": ["Validates schema", "Detects cycles"]
      },
      {
        "tempKey": "M2",
        "title": "Intake API route and atomic filing",
        "brief": "Expose preview and confirm actions via POST /api/board/intake.",
        "dependencies": ["M1"],
        "fileAllowlist": ["web-ui/app/api/board/intake/route.ts"],
        "acceptanceCriteria": ["Preview writes nothing", "Confirm files atomically"]
      }
    `; // intentionally missing ]}

  const repaired = repairAndParseIntakeJson(truncatedJson);
  assert.ok(repaired && Array.isArray(repaired.items) && repaired.items.length === 2);

  const generateFn: GenerateFn = async (req) => ({
    model: req.model,
    text: truncatedJson,
  });

  const preview = await previewMonsterIntake(
    { prompt: monsterPrompt },
    { store, scheduler, generateFn }
  );

  assert.equal(preview.items.length, 2);
  assert.equal(preview.items[0].tempKey, "M1");
  assert.deepEqual(preview.items[1].dependencies, ["M1"]);
  assert.equal(store.list().length, 0);
});

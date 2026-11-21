import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import http from "http";
import path from "path";
import { POST as compactRoutePOST } from "../app/api/threads/[id]/compact/route";
import {
  COMPACTION_PROMPT_V1,
  COMPACTION_MODEL_DIGEST_HEADER,
  HYBRID_ESCALATION_THRESHOLD,
  SUMMARIZATION_TEMPERATURE,
  SUMMARIZATION_MAX_TOKENS,
  SUMMARIZATION_INACTIVITY_MS,
  SUMMARIZATION_TOTAL_DEADLINE_MS,
  resolveCompactionStrategy,
  verifyIdentifierCoverage,
  runHybridCompaction,
  compactConversationHistory,
  summarizeTurnHistory,
} from "../lib/conversationCompaction";
import { ThreadStore, Thread } from "../lib/threads/threadStore";
import { estimateTokens, CHAT_CONTEXT_BUDGET_TOKENS } from "../lib/contextBudget";

const IDENTIFIER_MESSAGES = [
  {
    role: "user",
    content:
      "Inspect commit 86c8901c6433617cb9abe5db97123a0f52f58c89 and read web-ui/lib/contextBudget.ts, see https://github.com/test/repo",
  },
  { role: "assistant", content: "Execution error: failed to compile module at line 42." },
];

function buildLargeConversation(budgetTokens: number, utilizationRatio: number) {
  // estimateTokens = ceil(chars/4). The SOURCE conversation must exceed the 85%
  // compaction threshold so extraction fires, and the PRESERVED recent messages
  // must carry the bulk of the tokens so the POST-EXTRACTION model view lands at
  // utilizationRatio of the budget (the extraction digest itself is tiny, ~1.2K
  // tokens, so sizing only the replaced middle turns leaves the view at ~0.002
  // of budget and the hybrid summarizer is never invoked).
  const olderFillerTokens = Math.floor(budgetTokens * 0.45);
  const recentFillerTokens = Math.floor(budgetTokens * utilizationRatio);
  const olderFiller = "x".repeat(olderFillerTokens * 4);
  const recentFiller = "y".repeat(recentFillerTokens * 4);
  return [
    { role: "system", content: "System instructions for autonomous agent." },
    {
      role: "user",
      content:
        "First task: inspect web-ui/lib/contextBudget.ts and commit 86c8901c6433617cb9abe5db97123a0f52f58c89 on https://github.com/test/repo",
    },
    { role: "assistant", content: olderFiller },
    { role: "tool", name: "workspace_read_file", content: olderFiller },
    { role: "assistant", content: "Done." },
    { role: "user", content: "Recent question one" },
    { role: "assistant", content: recentFiller },
    { role: "user", content: "Recent question two" },
  ];
}

describe("Hybrid Compaction Suite (extraction + guarded model digest)", () => {
  it("flag default is extraction; COMPACTION_STRATEGY=hybrid selects hybrid", () => {
    const saved = process.env.COMPACTION_STRATEGY;
    try {
      delete process.env.COMPACTION_STRATEGY;
      assert.equal(resolveCompactionStrategy(), "extraction");
      process.env.COMPACTION_STRATEGY = "hybrid";
      assert.equal(resolveCompactionStrategy(), "hybrid");
      process.env.COMPACTION_STRATEGY = "EXTRACTION";
      assert.equal(resolveCompactionStrategy(), "extraction");
    } finally {
      if (saved === undefined) delete process.env.COMPACTION_STRATEGY;
      else process.env.COMPACTION_STRATEGY = saved;
    }
  });

  it("flag OFF reproduces extraction behavior exactly", async () => {
    const saved = process.env.COMPACTION_STRATEGY;
    try {
      delete process.env.COMPACTION_STRATEGY;
      const messages = buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.9);
      const extraction = compactConversationHistory(messages, {
        maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        compactionThreshold: 0.85,
        preserveRecentMessages: 3,
      });
      const hybridOff = await runHybridCompaction(messages, {
        maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        compactionThreshold: 0.85,
        preserveRecentMessages: 3,
        summarize: async () => "SHOULD NEVER BE CALLED",
      });
      assert.equal(hybridOff.strategy, "extraction");
      assert.equal(hybridOff.modelSummaryUsed, false);
      assert.deepEqual(hybridOff.messages, extraction.messages);
      assert.equal(hybridOff.tokensAfter, extraction.tokensAfter);
      assert.equal(hybridOff.liveContent, extraction.messages[1].content);
      assert.ok(!hybridOff.liveContent?.includes(COMPACTION_MODEL_DIGEST_HEADER));
    } finally {
      if (saved === undefined) delete process.env.COMPACTION_STRATEGY;
      else process.env.COMPACTION_STRATEGY = saved;
    }
  });

  it("escalation triggers only above the post-extraction 65% threshold; below it hybrid behaves exactly like extraction", async () => {
    const saved = process.env.COMPACTION_STRATEGY;
    try {
      process.env.COMPACTION_STRATEGY = "hybrid";
      assert.equal(HYBRID_ESCALATION_THRESHOLD, 0.65);

      // Below threshold: extraction digest alone, summarizer never invoked.
      let calls = 0;
      const below = await runHybridCompaction(
        buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.5),
        {
          maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
          compactionThreshold: 0.85,
          preserveRecentMessages: 3,
          summarize: async () => {
            calls++;
            return "unused";
          },
        }
      );
      assert.equal(below.compacted, true);
      assert.equal(below.modelSummaryUsed, false);
      assert.equal(calls, 0, "Summarizer must not run below the 65% post-extraction threshold");
      const extractionBelow = compactConversationHistory(
        buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.5),
        {
          maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
          compactionThreshold: 0.85,
          preserveRecentMessages: 3,
        }
      );
      assert.deepEqual(below.messages, extractionBelow.messages);

      // Above threshold: one summarization pass, live view headed with model digest header.
      let aboveCalls = 0;
      const above = await runHybridCompaction(
        buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.9),
        {
          maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
          compactionThreshold: 0.85,
          preserveRecentMessages: 3,
          summarize: async ({
            digest,
            replacedMessages,
            temperature,
            maxTokens,
            inactivityMs,
            totalDeadlineMs,
          }) => {
            aboveCalls++;
            assert.equal(temperature, SUMMARIZATION_TEMPERATURE);
            assert.equal(maxTokens, SUMMARIZATION_MAX_TOKENS);
            assert.equal(inactivityMs, SUMMARIZATION_INACTIVITY_MS);
            assert.equal(totalDeadlineMs, SUMMARIZATION_TOTAL_DEADLINE_MS);
            assert.ok(digest.includes("web-ui/lib/contextBudget.ts"));
            assert.ok(replacedMessages.length > 0);
            return `${COMPACTION_MODEL_DIGEST_HEADER}\nPrior User Goals & Requests:\n- inspect web-ui/lib/contextBudget.ts\nRetained Identifiers & Artifacts:\n- File paths: web-ui/lib/contextBudget.ts\n- Git SHAs: 86c8901c6433617cb9abe5db97123a0f52f58c89\n- URLs: https://github.com/test/repo\nCritical Errors & Failures:\n- Execution error: failed to compile module at line 42.`;
          },
        }
      );
      assert.equal(aboveCalls, 1, "Exactly ONE summarization pass");
      assert.equal(above.modelSummaryUsed, true);
      assert.equal(above.strategy, "hybrid");
      assert.ok(above.liveContent?.startsWith(COMPACTION_MODEL_DIGEST_HEADER));
      assert.equal(above.extractionDigest, summarizeTurnHistory(above.replacedMessages ?? []));
      assert.ok(above.messages[1].content.startsWith(COMPACTION_MODEL_DIGEST_HEADER));
    } finally {
      if (saved === undefined) delete process.env.COMPACTION_STRATEGY;
      else process.env.COMPACTION_STRATEGY = saved;
    }
  });

  it("fallback fires on simulated generation failure AND on timeout", async () => {
    const saved = process.env.COMPACTION_STRATEGY;
    try {
      process.env.COMPACTION_STRATEGY = "hybrid";
      const failure = await runHybridCompaction(
        buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.9),
        {
          maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
          compactionThreshold: 0.85,
          preserveRecentMessages: 3,
          summarize: async () => {
            throw new Error("engine_stopped: generation failed");
          },
        }
      );
      assert.equal(failure.modelSummaryUsed, false);
      assert.equal(failure.fallback, true);
      assert.equal(failure.fallbackReason, "generation_failure");
      assert.ok(failure.liveContent?.includes("[CONVERSATION COMPACTED (85% THRESHOLD)]"));

      const timeout = await runHybridCompaction(
        buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.9),
        {
          maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
          compactionThreshold: 0.85,
          preserveRecentMessages: 3,
          summarize: async () => {
            await new Promise((_, reject) =>
              setTimeout(() => reject(new Error("inactivity deadline exceeded")), 20)
            );
            return "never returned";
          },
        }
      );
      assert.equal(timeout.modelSummaryUsed, false);
      assert.equal(timeout.fallback, true);
      assert.equal(timeout.fallbackReason, "timeout");
    } finally {
      if (saved === undefined) delete process.env.COMPACTION_STRATEGY;
      else process.env.COMPACTION_STRATEGY = saved;
    }
  });

  it("REAL deadline: never-resolving stub times out via the wrapper's injectable deadlines", async () => {
    // Fail-before: the prior timeout test rejected from the STUB itself
    // (setTimeout(() => reject(new Error("inactivity deadline exceeded")), 20)),
    // so it passed even if the deadline wrapper had no timers at all. Here the
    // stub never settles; only the wrapper's injected deadlines can end the pass.
    const saved = process.env.COMPACTION_STRATEGY;
    try {
      process.env.COMPACTION_STRATEGY = "hybrid";
      const neverResolves = () => new Promise<never>(() => {});

      const startedTotal = Date.now();
      const total = await runHybridCompaction(
        buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.9),
        {
          maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
          compactionThreshold: 0.85,
          preserveRecentMessages: 3,
          totalDeadlineMs: 120,
          inactivityMs: 10_000,
          summarize: () => neverResolves(),
        }
      );
      const elapsedTotal = Date.now() - startedTotal;
      assert.equal(total.modelSummaryUsed, false);
      assert.equal(total.fallback, true);
      assert.equal(total.fallbackReason, "timeout");
      assert.ok(elapsedTotal >= 100, `total deadline must fire (~120ms), got ${elapsedTotal}ms`);
      assert.ok(elapsedTotal < 2000, `must not hang past the deadline, got ${elapsedTotal}ms`);

      const startedSilent = Date.now();
      const silent = await runHybridCompaction(
        buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.9),
        {
          maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
          compactionThreshold: 0.85,
          preserveRecentMessages: 3,
          inactivityMs: 120,
          totalDeadlineMs: 10_000,
          summarize: () => neverResolves(),
        }
      );
      const elapsedSilent = Date.now() - startedSilent;
      assert.equal(silent.fallbackReason, "timeout");
      assert.ok(
        elapsedSilent >= 100,
        `inactivity deadline must fire (~120ms), got ${elapsedSilent}ms`
      );
      assert.ok(
        elapsedSilent < 2000,
        `must not hang past the inactivity deadline, got ${elapsedSilent}ms`
      );
    } finally {
      if (saved === undefined) delete process.env.COMPACTION_STRATEGY;
      else process.env.COMPACTION_STRATEGY = saved;
    }
  });

  it("onProgress resets the inactivity deadline; the total deadline still fires regardless", async () => {
    // Proves the route-adapter progress hook is load-bearing: a stub that emits
    // chunks (calling req.onProgress) faster than inactivityMs never trips the
    // inactivity timer, yet the total deadline still aborts the pass.
    const saved = process.env.COMPACTION_STRATEGY;
    try {
      process.env.COMPACTION_STRATEGY = "hybrid";
      const started = Date.now();
      const result = await runHybridCompaction(
        buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.9),
        {
          maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
          compactionThreshold: 0.85,
          preserveRecentMessages: 3,
          inactivityMs: 60,
          totalDeadlineMs: 200,
          summarize: (req) =>
            new Promise<never>(() => {
              const tick = setInterval(() => req.onProgress?.(), 20);
              req.signal?.addEventListener("abort", () => clearInterval(tick));
            }),
        }
      );
      const elapsed = Date.now() - started;
      assert.equal(result.fallback, true);
      assert.equal(result.fallbackReason, "timeout");
      assert.ok(elapsed >= 180, `total deadline must fire (~200ms), got ${elapsed}ms`);
      assert.ok(elapsed < 1000, `inactivity must have been reset per chunk, got ${elapsed}ms`);
    } finally {
      if (saved === undefined) delete process.env.COMPACTION_STRATEGY;
      else process.env.COMPACTION_STRATEGY = saved;
    }
  });
  it("identifier post-check rejects an incomplete summary (missing path/SHA/URL from the digest)", async () => {
    const saved = process.env.COMPACTION_STRATEGY;
    try {
      process.env.COMPACTION_STRATEGY = "hybrid";
      const digest = summarizeTurnHistory(IDENTIFIER_MESSAGES);
      const complete = `${COMPACTION_MODEL_DIGEST_HEADER}\n- web-ui/lib/contextBudget.ts\n- 86c8901c6433617cb9abe5db97123a0f52f58c89\n- https://github.com/test/repo`;
      assert.equal(verifyIdentifierCoverage(digest, complete).ok, true);

      const missingSha = `${COMPACTION_MODEL_DIGEST_HEADER}\n- web-ui/lib/contextBudget.ts\n- https://github.com/test/repo`;
      const shaCheck = verifyIdentifierCoverage(digest, missingSha);
      assert.equal(shaCheck.ok, false);
      assert.ok(shaCheck.missing.some((v) => v.includes("86c8901")));

      const missingPath = `${COMPACTION_MODEL_DIGEST_HEADER}\n- 86c8901c6433617cb9abe5db97123a0f52f58c89\n- https://github.com/test/repo`;
      assert.equal(verifyIdentifierCoverage(digest, missingPath).ok, false);

      const missingUrl = `${COMPACTION_MODEL_DIGEST_HEADER}\n- web-ui/lib/contextBudget.ts\n- 86c8901c6433617cb9abe5db97123a0f52f58c89`;
      assert.equal(verifyIdentifierCoverage(digest, missingUrl).ok, false);

      // Rejection routes to extraction fallback, digest retained.
      const res = await runHybridCompaction(
        IDENTIFIER_MESSAGES.concat(
          buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.9).slice(1)
        ),
        {
          maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
          compactionThreshold: 0.85,
          preserveRecentMessages: 3,
          summarize: async () => `${COMPACTION_MODEL_DIGEST_HEADER}\n- web-ui/lib/contextBudget.ts`,
        }
      );
      assert.equal(res.modelSummaryUsed, false);
      assert.equal(res.fallback, true);
      assert.equal(res.fallbackReason, "identifier_post_check_rejected");
      assert.ok(res.liveContent?.includes("86c8901c6433617cb9abe5db97123a0f52f58c89"));
      assert.ok(res.liveContent?.includes("https://github.com/test/repo"));
    } finally {
      if (saved === undefined) delete process.env.COMPACTION_STRATEGY;
      else process.env.COMPACTION_STRATEGY = saved;
    }
  });

  it("truncation of the model summary falls back to the extraction digest", async () => {
    const saved = process.env.COMPACTION_STRATEGY;
    try {
      process.env.COMPACTION_STRATEGY = "hybrid";
      const res = await runHybridCompaction(
        buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.9),
        {
          maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
          compactionThreshold: 0.85,
          preserveRecentMessages: 3,
          summarize: async () => ({
            text: `${COMPACTION_MODEL_DIGEST_HEADER}\n- web-ui/lib/contextBudget.ts\n- 86c8901c6433617cb9abe5db97123a0f52f58c89\n- https://github.com/test/repo`,
            truncated: true,
          }),
        }
      );
      assert.equal(res.modelSummaryUsed, false);
      assert.equal(res.fallback, true);
      assert.equal(res.fallbackReason, "truncated");
    } finally {
      if (saved === undefined) delete process.env.COMPACTION_STRATEGY;
      else process.env.COMPACTION_STRATEGY = saved;
    }
  });

  it("the shipped prompt constant carries the v1 sections and rules verbatim", () => {
    assert.ok(
      COMPACTION_PROMPT_V1.startsWith(
        "You are compacting the working memory of an ongoing conversation"
      )
    );
    assert.ok(COMPACTION_PROMPT_V1.includes("RULES — inviolable, in priority order:"));
    assert.ok(COMPACTION_PROMPT_V1.includes("1. NEVER INVENT."));
    assert.ok(COMPACTION_PROMPT_V1.includes("2. IDENTIFIERS VERBATIM."));
    assert.ok(COMPACTION_PROMPT_V1.includes("3. CORRECTIONS WIN."));
    assert.ok(COMPACTION_PROMPT_V1.includes("4. CONSTRAINTS IN FULL."));
    assert.ok(COMPACTION_PROMPT_V1.includes("5. DECISIONS KEEP THEIR REASONS."));
    assert.ok(COMPACTION_PROMPT_V1.includes("6. OPEN THREADS STAY OPEN."));
    assert.ok(COMPACTION_PROMPT_V1.includes("7. ERRORS VERBATIM."));
    assert.ok(COMPACTION_PROMPT_V1.includes("8. COMPRESS REPETITION."));
    assert.ok(COMPACTION_PROMPT_V1.includes("9. ORDER."));
    assert.ok(COMPACTION_PROMPT_V1.includes(COMPACTION_MODEL_DIGEST_HEADER));
    assert.ok(COMPACTION_PROMPT_V1.includes("Prior User Goals & Requests:"));
    assert.ok(COMPACTION_PROMPT_V1.includes("Key Decisions & Rationale:"));
    assert.ok(COMPACTION_PROMPT_V1.includes("User Constraints & Preferences:"));
    assert.ok(COMPACTION_PROMPT_V1.includes("Key Insights & Outcomes:"));
    assert.ok(COMPACTION_PROMPT_V1.includes("Open Threads:"));
    assert.ok(COMPACTION_PROMPT_V1.includes("Retained Identifiers & Artifacts:"));
    assert.ok(COMPACTION_PROMPT_V1.includes("Critical Errors & Failures:"));
    assert.ok(
      COMPACTION_PROMPT_V1.includes(
        "LENGTH: your output must be substantially shorter than the source."
      )
    );
    assert.ok(COMPACTION_PROMPT_V1.includes("Target under 4,000 tokens"));
    assert.ok(COMPACTION_PROMPT_V1.includes("(supersedes: <old value>)"));
    // Guardrail constants pinned by owner ruling.
    assert.equal(SUMMARIZATION_TEMPERATURE, 0.2);
    assert.equal(SUMMARIZATION_MAX_TOKENS, 8192);
    assert.equal(SUMMARIZATION_INACTIVITY_MS, 180000);
    assert.equal(SUMMARIZATION_TOTAL_DEADLINE_MS, 300000);
  });

  it("the extraction digest is always retained in the thread record alongside the model summary", async () => {
    const saved = process.env.COMPACTION_STRATEGY;
    const tmpDir = path.resolve("./.tmp-test-hybrid-compaction-" + Date.now());
    try {
      process.env.COMPACTION_STRATEGY = "hybrid";
      const store = new ThreadStore(tmpDir);
      const filler = "x".repeat(Math.floor(CHAT_CONTEXT_BUDGET_TOKENS * 0.9) * 4);
      const thread: Thread = {
        id: "thread-hybrid-1",
        title: "Hybrid Thread",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        model: "swift-15-27b-mtp",
        reasoningEffort: "medium",
        messages: [
          {
            id: "m1",
            role: "user",
            content:
              "Inspect web-ui/lib/contextBudget.ts commit 86c8901c6433617cb9abe5db97123a0f52f58c89 https://github.com/test/repo",
            timestamp: "now",
          },
          { id: "m2", role: "assistant", content: "Working on it.", timestamp: "now" },
          {
            id: "m3",
            role: "tool" as unknown as Thread["messages"][number]["role"],
            content: "File contents retrieved.",
            timestamp: "now",
          },
          { id: "m4", role: "assistant", content: "Done.", timestamp: "now" },
          { id: "m5", role: "user", content: "Recent question one", timestamp: "now" },
          { id: "m6", role: "assistant", content: filler, timestamp: "now" },
          { id: "m7", role: "user", content: "Recent question two", timestamp: "now" },
        ],
      };
      store.saveThread(thread);

      const res = await store.compactThreadIncrementalHybrid(thread, {
        summarize: async ({ digest }) =>
          `${COMPACTION_MODEL_DIGEST_HEADER}\nPrior User Goals & Requests:\n- inspect contextBudget\nRetained Identifiers & Artifacts:\n- File paths: web-ui/lib/contextBudget.ts\n- Git SHAs: 86c8901c6433617cb9abe5db97123a0f52f58c89\n- URLs: https://github.com/test/repo\n` +
          digest,
      });
      assert.equal(res.noop, false);
      assert.equal(res.modelSummaryUsed, true);

      const savedThread = (await store.getThread(thread.id))!;
      assert.ok(savedThread.compaction, "compaction boundary persisted");
      assert.ok(
        savedThread.compaction!.summary.startsWith(COMPACTION_MODEL_DIGEST_HEADER),
        "live summary is the model digest"
      );
      assert.ok(
        savedThread.compaction!.extractionDigest,
        "extraction digest retained as audit copy"
      );
      assert.ok(
        savedThread.compaction!.extractionDigest!.includes(
          "86c8901c6433617cb9abe5db97123a0f52f58c89"
        )
      );
      assert.ok(savedThread.compaction!.extractionDigest!.includes("web-ui/lib/contextBudget.ts"));
      assert.ok(savedThread.compaction!.extractionDigest!.includes("https://github.com/test/repo"));
      assert.equal(savedThread.compaction!.strategy, "hybrid");
      assert.ok(
        estimateTokens(savedThread.compaction!.summary) <
          estimateTokens(savedThread.compaction!.extractionDigest!) ||
          savedThread.compaction!.summary.length > 0
      );

      // Model view uses the live summary; audit copy never becomes the only record.
      const modelView = store.buildModelMessages(savedThread);
      assert.ok(modelView.some((m) => m.content.startsWith(COMPACTION_MODEL_DIGEST_HEADER)));
    } finally {
      if (saved === undefined) delete process.env.COMPACTION_STRATEGY;
      else process.env.COMPACTION_STRATEGY = saved;
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("thread record retains extraction digest when the model pass falls back", async () => {
    const saved = process.env.COMPACTION_STRATEGY;
    const tmpDir = path.resolve("./.tmp-test-hybrid-fallback-" + Date.now());
    try {
      process.env.COMPACTION_STRATEGY = "hybrid";
      const store = new ThreadStore(tmpDir);
      const filler = "x".repeat(Math.floor(CHAT_CONTEXT_BUDGET_TOKENS * 0.9) * 4);
      const thread: Thread = {
        id: "thread-hybrid-2",
        title: "Hybrid Fallback Thread",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        model: "swift-15-27b-mtp",
        reasoningEffort: "medium",
        messages: [
          {
            id: "m1",
            role: "user",
            content:
              "Inspect web-ui/lib/contextBudget.ts commit 86c8901c6433617cb9abe5db97123a0f52f58c89 https://github.com/test/repo",
            timestamp: "now",
          },
          { id: "m2", role: "assistant", content: "Working on it.", timestamp: "now" },
          {
            id: "m3",
            role: "tool" as unknown as Thread["messages"][number]["role"],
            content: "File contents retrieved.",
            timestamp: "now",
          },
          { id: "m4", role: "assistant", content: "Done.", timestamp: "now" },
          { id: "m5", role: "user", content: "Recent question one", timestamp: "now" },
          { id: "m6", role: "assistant", content: filler, timestamp: "now" },
          { id: "m7", role: "user", content: "Recent question two", timestamp: "now" },
        ],
      };
      store.saveThread(thread);

      const res = await store.compactThreadIncrementalHybrid(thread, {
        summarize: async () => {
          throw new Error("engine refused summarization");
        },
      });
      assert.equal(res.noop, false);
      assert.equal(res.modelSummaryUsed, false);
      assert.equal(res.fallbackReason, "generation_failure");

      const savedThread = (await store.getThread(thread.id))!;
      assert.ok(savedThread.compaction!.extractionDigest);
      assert.ok(
        savedThread.compaction!.summary.includes("[CONVERSATION COMPACTED (85% THRESHOLD)]")
      );
      assert.ok(savedThread.compaction!.fallbackLogged, "fallback logged on the thread record");
      assert.ok(savedThread.compaction!.fallbackReason);
    } finally {
      if (saved === undefined) delete process.env.COMPACTION_STRATEGY;
      else process.env.COMPACTION_STRATEGY = saved;
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("chat route call-site wires COMPACTION_STRATEGY=hybrid to the async rung; flag OFF keeps the extraction call", () => {
    // Seam test on the call-site selection at app/api/chat/route.ts (in-turn ladder
    // compaction). Fail-before: at HEAD 3fedd43 this slice contained a single
    // unconditional threadStore.compactThreadIncremental(threadData) with no
    // strategy branch and no hybrid rung, so every assertion below was red.
    const routeSrc = fs.readFileSync(path.resolve(process.cwd(), "app/api/chat/route.ts"), "utf8");
    const anchor = routeSrc.indexOf("const compaction = fitConversationToBudget(");
    assert.ok(anchor >= 0, "chat route must contain the in-turn ladder compaction call-site");
    const slice = routeSrc.slice(anchor, anchor + 5000);
    assert.ok(
      slice.includes(`resolveCompactionStrategy() === "hybrid"`),
      "call-site must branch on the resolved strategy"
    );
    assert.match(
      slice,
      /await\s+threadStore\.compactThreadIncrementalHybrid\(\s*threadData/,
      "hybrid branch must await the async store rung"
    );
    assert.ok(slice.includes("} else {"), "extraction branch must be the else path");
    assert.ok(
      slice.includes("threadStore.compactThreadIncremental(threadData);"),
      "flag OFF keeps the existing synchronous extraction call"
    );
    // The call-site adapter feeds the rung request contract (prompt verbatim,
    // digest as source, signal + guardrail options); the summarization pass,
    // identifier post-check, deadlines, and fallback all live in the rung.
    assert.ok(
      slice.includes("content: sumReq.prompt"),
      "summarize adapter must send COMPACTION_PROMPT_V1 verbatim"
    );
    assert.ok(
      slice.includes("content: sumReq.digest"),
      "summarize adapter must send the extraction digest"
    );
    assert.ok(
      slice.includes("signal: sumReq.signal"),
      "summarize adapter must honor the rung deadline signal"
    );
    assert.ok(
      slice.includes("sumReq.onProgress?.()"),
      "summarize adapter must call the rung progress hook per chunk (resets the inactivity deadline)"
    );
    assert.ok(
      slice.includes("num_predict: sumReq.maxTokens"),
      "summarize adapter must carry the pinned maxTokens"
    );
    assert.match(
      routeSrc,
      /import\s*\{\s*compactConversationHistory,\s*resolveCompactionStrategy,?\s*\}\s*from\s*"@\/lib\/conversationCompaction";/,
      "route must import the strategy resolver"
    );
    // Manual compact endpoint honors COMPACTION_STRATEGY (AUD-10).
    const compactSrc = fs.readFileSync(
      path.resolve(process.cwd(), "app/api/threads/[id]/compact/route.ts"),
      "utf8"
    );
    assert.ok(
      compactSrc.includes("threadStore.compactThreadIncremental(thread)"),
      "manual compact endpoint keeps extraction path"
    );
    assert.ok(
      compactSrc.includes("compactThreadIncrementalHybrid"),
      "manual compact endpoint invokes hybrid rung when strategy=hybrid"
    );
    assert.ok(
      compactSrc.includes("resolveCompactionStrategy"),
      "manual compact endpoint branches on strategy"
    );
  });

  // HYBRID TURN-START WIRING FIX (fail-before): at HEAD 2ecf71b
  // prepareTurnConversationMessages always calls the synchronous extraction
  // compactThreadIncremental and never consults COMPACTION_STRATEGY, so a thread
  // crossing the 85% trigger at TURN START gets the extraction digest even when
  // strategy=hybrid and a summarize callback are supplied. The hybrid rung is only
  // reachable from the mid-turn fitConversationToBudget branch, which turn-start
  // compaction pre-empts (post-turn-start view is below the fit thresholds, so the
  // hybrid store function no-ops as already_compacted).
  // Fixture shape: the bulk of the tokens sits in the REPLACED middle turn (t3) so
  // extraction does not no-op as already_optimal, and the preserved tail (t6) keeps
  // the post-extraction view above the 65% hybrid escalation rung.
  // Fixture typing is any[] (not ThreadMessage[]): the fixture carries a tool-role message,
  // mirroring the pre-existing fixtures above (lines 363/417 use the same tool-role shape).
  const TURN_START_MESSAGES = (prefix: string): Thread["messages"] =>
    [
      {
        id: `${prefix}-1`,
        role: "user",
        content:
          "Inspect web-ui/lib/contextBudget.ts commit 86c8901c6433617cb9abe5db97123a0f52f58c89 https://github.com/test/repo",
        timestamp: "now",
      },
      {
        id: `${prefix}-2`,
        role: "assistant",
        content: "Execution error: failed to compile module at line 42.",
        timestamp: "now",
      },
      {
        id: `${prefix}-3`,
        role: "tool",
        name: "workspace_read_file",
        content: "x".repeat(30000 * 4),
        timestamp: "now",
      },
      { id: `${prefix}-4`, role: "assistant", content: "Done.", timestamp: "now" },
      { id: `${prefix}-5`, role: "user", content: "Recent question one", timestamp: "now" },
      { id: `${prefix}-6`, role: "assistant", content: "y".repeat(66000 * 4), timestamp: "now" },
      { id: `${prefix}-7`, role: "user", content: "Recent question two", timestamp: "now" },
    ] as unknown as Thread["messages"];

  const makeTurnStartThread = (id: string): Thread => ({
    id,
    title: "Turn-Start Thread",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    model: "swift-15-27b-mtp",
    reasoningEffort: "medium",
    messages: TURN_START_MESSAGES(id),
  });

  it("turn-start prepare honors strategy=hybrid: boundary summary is the MODEL DIGEST, extraction digest retained", async () => {
    const saved = process.env.COMPACTION_STRATEGY;
    const tmpDir = path.resolve("./.tmp-test-hybrid-turnstart-" + Date.now());
    try {
      process.env.COMPACTION_STRATEGY = "hybrid";
      const store = new ThreadStore(tmpDir);
      const thread = makeTurnStartThread("thread-hybrid-turnstart-a");
      store.saveThread(thread);

      let calls = 0;
      const prep = await store.prepareTurnConversationMessages(
        thread,
        [...thread.messages],
        CHAT_CONTEXT_BUDGET_TOKENS,
        {
          strategy: "hybrid",
          summarize: async ({ digest }) => {
            calls++;
            return (
              `${COMPACTION_MODEL_DIGEST_HEADER}\nPrior User Goals & Requests:\n- inspect contextBudget\nRetained Identifiers & Artifacts:\n- File paths: web-ui/lib/contextBudget.ts\n- Git SHAs: 86c8901c6433617cb9abe5db97123a0f52f58c89\n- URLs: https://github.com/test/repo\nCritical Errors & Failures:\n- Execution error: failed to compile module at line 42.\n` +
              digest
            );
          },
        }
      );

      assert.equal(prep.compactedThisTurn, true, "turn-start must report compaction");
      assert.ok(
        prep.tokensBeforeCompaction! > Math.floor(CHAT_CONTEXT_BUDGET_TOKENS * 0.85),
        "model view must exceed the 85% trigger"
      );
      assert.ok(prep.tokensAfterCompaction! < prep.tokensBeforeCompaction!, "tokens must shrink");
      assert.equal(calls, 1, "exactly ONE summarization pass at turn start");
      assert.ok(
        prep.messages.some((m) => m.content.startsWith(COMPACTION_MODEL_DIGEST_HEADER)),
        "model view must carry the model digest"
      );

      const savedThread = (await store.getThread(thread.id))!;
      assert.ok(savedThread.compaction, "compaction boundary persisted");
      assert.ok(
        savedThread.compaction!.summary.startsWith(COMPACTION_MODEL_DIGEST_HEADER),
        "boundary summary must begin with the MODEL DIGEST header"
      );
      assert.equal(savedThread.compaction!.strategy, "hybrid");
      assert.ok(
        savedThread.compaction!.extractionDigest,
        "extraction digest retained as audit copy"
      );
      assert.ok(
        savedThread.compaction!.extractionDigest!.startsWith(
          "[CONVERSATION COMPACTED (85% THRESHOLD)]"
        ),
        "audit copy is the extraction digest"
      );
      assert.ok(
        savedThread.compaction!.extractionDigest!.includes(
          "86c8901c6433617cb9abe5db97123a0f52f58c89"
        )
      );
      assert.ok(savedThread.compaction!.extractionDigest!.includes("web-ui/lib/contextBudget.ts"));
      assert.ok(savedThread.compaction!.extractionDigest!.includes("https://github.com/test/repo"));
    } finally {
      if (saved === undefined) delete process.env.COMPACTION_STRATEGY;
      else process.env.COMPACTION_STRATEGY = saved;
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("turn-start prepare with strategy=extraction, hybrid without summarize, or no options produces the extraction digest exactly as today", async () => {
    const saved = process.env.COMPACTION_STRATEGY;
    const tmpDir = path.resolve("./.tmp-test-hybrid-turnstart-extraction-" + Date.now());
    try {
      const store = new ThreadStore(tmpDir);

      const assertExtractionIdentical = async (
        thread: Thread,
        prep: Awaited<ReturnType<typeof store.prepareTurnConversationMessages>>,
        summarizeCalls: number
      ) => {
        assert.equal(prep.compactedThisTurn, true, "turn-start must report compaction");
        assert.equal(summarizeCalls, 0, "summarizer must never be invoked on the extraction rung");
        assert.ok(
          !prep.messages.some((m) => m.content.startsWith(COMPACTION_MODEL_DIGEST_HEADER)),
          "model view must not carry a model digest"
        );
        const savedThread = (await store.getThread(thread.id))!;
        assert.ok(savedThread.compaction);
        assert.ok(
          savedThread.compaction!.summary.startsWith("[CONVERSATION COMPACTED (85% THRESHOLD)]"),
          "boundary summary is the extraction digest"
        );
        assert.ok(!savedThread.compaction!.summary.includes(COMPACTION_MODEL_DIGEST_HEADER));
        assert.equal(
          savedThread.compaction!.strategy,
          undefined,
          "extraction boundary carries no strategy field"
        );
        assert.equal(
          savedThread.compaction!.extractionDigest,
          undefined,
          "extraction boundary carries no audit copy"
        );
        assert.equal(
          savedThread.compaction!.summary,
          summarizeTurnHistory(thread.messages.slice(0, thread.messages.length - 4)),
          "digest must be byte-identical to today's extraction output"
        );
        assert.equal(
          prep.messages[0].content,
          savedThread.compaction!.summary,
          "model view is headed by the extraction digest"
        );
      };

      // (b1) explicit strategy=extraction WITH a summarize callback present.
      process.env.COMPACTION_STRATEGY = "hybrid";
      const t1 = makeTurnStartThread("thread-turnstart-extraction-explicit");
      store.saveThread(t1);
      let calls1 = 0;
      const prep1 = await store.prepareTurnConversationMessages(
        t1,
        [...t1.messages],
        CHAT_CONTEXT_BUDGET_TOKENS,
        {
          strategy: "extraction",
          summarize: async () => {
            calls1++;
            return "MUST NEVER BE CALLED";
          },
        }
      );
      await assertExtractionIdentical(t1, prep1, calls1);

      // (b2) strategy=hybrid WITHOUT a summarize callback -> extraction rung.
      const t2 = makeTurnStartThread("thread-turnstart-hybrid-no-summarize");
      store.saveThread(t2);
      const prep2 = await store.prepareTurnConversationMessages(
        t2,
        [...t2.messages],
        CHAT_CONTEXT_BUDGET_TOKENS,
        { strategy: "hybrid" }
      );
      await assertExtractionIdentical(t2, prep2, 0);

      // (b3) no options argument at all, flag OFF -> legacy synchronous extraction.
      delete process.env.COMPACTION_STRATEGY;
      const t3 = makeTurnStartThread("thread-turnstart-no-options");
      store.saveThread(t3);
      const prep3 = await store.prepareTurnConversationMessages(
        t3,
        [...t3.messages],
        CHAT_CONTEXT_BUDGET_TOKENS
      );
      await assertExtractionIdentical(t3, prep3, 0);
    } finally {
      if (saved === undefined) delete process.env.COMPACTION_STRATEGY;
      else process.env.COMPACTION_STRATEGY = saved;
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("(a) mid-turn hybrid compaction puts the hybrid digest into the live message view and updates events", async () => {
    // 1. Verify the chat route mid-turn branch captures the hybrid result,
    //    rebuilds the live conversationMessages via buildModelMessages(threadData),
    //    and reports the hybrid tokens/actions rather than discarding the result.
    const routeSrc = fs.readFileSync(path.resolve(process.cwd(), "app/api/chat/route.ts"), "utf8");
    const anchor = routeSrc.indexOf("const compaction = fitConversationToBudget(");
    assert.ok(anchor >= 0, "chat route must contain mid-turn fitConversationToBudget");
    const slice = routeSrc.slice(anchor, anchor + 5000);
    assert.ok(
      /const\s+hybridResult\s*=\s*await\s+threadStore\.compactThreadIncrementalHybrid\(\s*threadData/.test(
        slice
      ),
      "mid-turn hybrid branch must capture the compactThreadIncrementalHybrid result"
    );
    assert.ok(
      slice.includes("threadStore.buildModelMessages(threadData)"),
      "mid-turn hybrid branch must rebuild live conversationMessages from buildModelMessages(threadData)"
    );
    assert.ok(
      slice.includes("!hybridResult.noop"),
      "mid-turn hybrid branch must guard rebuild on !hybridResult.noop and fall back to extraction fit on noop"
    );
    assert.ok(
      slice.includes("hybridResult.tokensBefore") && slice.includes("hybridResult.tokensAfter"),
      "mid-turn hybrid branch must report hybrid tokensBefore/tokensAfter in turn state and SSE events"
    );

    // 2. Behavioral verification: compactThreadIncrementalHybrid + buildModelMessages
    //    leaves the hybrid digest in the live view, drops compacted-away raw messages,
    //    preserves the 4-message recent tail, and keeps the record boundary consistent.
    const saved = process.env.COMPACTION_STRATEGY;
    const tmpDir = path.resolve("./.tmp-test-midturn-hybrid-" + Date.now());
    try {
      process.env.COMPACTION_STRATEGY = "hybrid";
      const store = new ThreadStore(tmpDir);
      const thread = makeTurnStartThread("thread-midturn-hybrid");
      store.saveThread(thread);

      const hybridResult = await store.compactThreadIncrementalHybrid(thread, {
        summarize: async () =>
          `${COMPACTION_MODEL_DIGEST_HEADER}\nPrior User Goals & Requests:\n- inspect contextBudget\nRetained Identifiers & Artifacts:\n- File paths: web-ui/lib/contextBudget.ts\n- Git SHAs: 86c8901c6433617cb9abe5db97123a0f52f58c89\n- URLs: https://github.com/test/repo`,
      });
      assert.equal(hybridResult.noop, false);
      assert.equal(hybridResult.modelSummaryUsed, true);

      const rebuilt = store.buildModelMessages(thread);
      assert.ok(
        rebuilt.some((m) => m.content.startsWith(COMPACTION_MODEL_DIGEST_HEADER)),
        "live view must carry the hybrid model digest"
      );
      assert.ok(
        !rebuilt.some((m) => m.content.includes("x".repeat(100))),
        "compacted-away raw tool output must be absent from the live view"
      );
      assert.equal(
        rebuilt[rebuilt.length - 1].content,
        "Recent question two",
        "recent tail must be preserved"
      );
      assert.equal(
        rebuilt[rebuilt.length - 3].content,
        "Recent question one",
        "recent tail must be preserved"
      );
      const savedThread = (await store.getThread(thread.id))!;
      assert.equal(savedThread.compaction?.throughMessageId, hybridResult.throughMessageId);
      assert.equal(savedThread.compaction?.summary, hybridResult.summary);
    } finally {
      if (saved === undefined) delete process.env.COMPACTION_STRATEGY;
      else process.env.COMPACTION_STRATEGY = saved;
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("(b) /compact route honors COMPACTION_STRATEGY: hybrid invokes summarizer, unset keeps extraction", async () => {
    const savedStrategy = process.env.COMPACTION_STRATEGY;
    const savedThreadsDir = process.env.THREADS_DIR;
    const savedLlmBaseUrl = process.env.LLM_BASE_URL;
    const savedProvider = process.env.LLM_PROVIDER;
    const tmpDir = path.resolve("./.tmp-test-compact-route-strategy-" + Date.now());
    let llmCalls = 0;

    // Local mock Ollama-compatible streaming server for the hybrid summarization pass
    const mockModelDigest = `${COMPACTION_MODEL_DIGEST_HEADER}\nPrior User Goals & Requests:\n- inspect contextBudget\nRetained Identifiers & Artifacts:\n- File paths: web-ui/lib/contextBudget.ts\n- Git SHAs: 86c8901c6433617cb9abe5db97123a0f52f58c89\n- URLs: https://github.com/test/repo\nCritical Errors & Failures:\n- Execution error: failed to compile module at line 42.`;
    const server = http.createServer((_req, res) => {
      llmCalls++;
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(
        JSON.stringify({ message: { role: "assistant", content: mockModelDigest }, done: false }) +
          "\n"
      );
      res.write(
        JSON.stringify({
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
        }) + "\n"
      );
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as { port: number };

    try {
      process.env.THREADS_DIR = tmpDir;
      process.env.LLM_BASE_URL = `http://127.0.0.1:${addr.port}`;
      process.env.LLM_PROVIDER = "ollama";
      const store = new ThreadStore(tmpDir);

      // 1. Strategy unset -> extraction path, response shape unchanged, LLM never called
      delete process.env.COMPACTION_STRATEGY;
      const extractionThread = makeTurnStartThread("thread-compact-route-extraction");
      store.saveThread(extractionThread);
      const req1 = new Request(`http://localhost/api/threads/${extractionThread.id}/compact`, {
        method: "POST",
      });
      const res1 = await compactRoutePOST(req1, {
        params: Promise.resolve({ id: extractionThread.id }),
      });
      const data1 = await res1.json();
      assert.equal(res1.status, 200);
      assert.equal(data1.noop, false);
      assert.equal(
        data1.modelSummaryUsed,
        undefined,
        "extraction response shape must remain unchanged"
      );
      assert.ok(data1.summary.startsWith("[CONVERSATION COMPACTED (85% THRESHOLD)]"));
      assert.equal(llmCalls, 0, "extraction path must not call the LLM");

      // 2. Strategy = hybrid -> hybrid path, summarizer callback exercised
      process.env.COMPACTION_STRATEGY = "hybrid";
      const hybridThread = makeTurnStartThread("thread-compact-route-hybrid");
      store.saveThread(hybridThread);
      const req2 = new Request(`http://localhost/api/threads/${hybridThread.id}/compact`, {
        method: "POST",
      });
      const res2 = await compactRoutePOST(req2, {
        params: Promise.resolve({ id: hybridThread.id }),
      });
      const data2 = await res2.json();
      assert.equal(res2.status, 200);
      assert.equal(data2.noop, false);
      assert.equal(llmCalls, 1, "hybrid /compact must invoke the summarization pass");
      assert.equal(
        data2.modelSummaryUsed,
        true,
        "hybrid /compact must report modelSummaryUsed=true"
      );
      assert.ok(
        data2.summary.startsWith(COMPACTION_MODEL_DIGEST_HEADER),
        "hybrid /compact must return model digest"
      );
    } finally {
      server.close();
      if (savedStrategy === undefined) delete process.env.COMPACTION_STRATEGY;
      else process.env.COMPACTION_STRATEGY = savedStrategy;
      if (savedThreadsDir === undefined) delete process.env.THREADS_DIR;
      else process.env.THREADS_DIR = savedThreadsDir;
      if (savedLlmBaseUrl === undefined) delete process.env.LLM_BASE_URL;
      else process.env.LLM_BASE_URL = savedLlmBaseUrl;
      if (savedProvider === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = savedProvider;
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("(c) signal provenance: unrelated external abort does not stop summarization; deadline signal does; chat route closures do not shadow req", async () => {
    // 1. Verify neither summarizer closure in chat/route.ts shadows the HTTP `req` parameter
    const routeSrc = fs.readFileSync(path.resolve(process.cwd(), "app/api/chat/route.ts"), "utf8");
    assert.ok(
      !routeSrc.includes("summarize: async (req)"),
      "chat route summarizer closures must not shadow the HTTP `req` parameter"
    );

    // 2. Prove summarization completes when an unrelated external signal aborts mid-pass,
    //    and is cut when the deadline wrapper's own signal fires.
    const saved = process.env.COMPACTION_STRATEGY;
    try {
      process.env.COMPACTION_STRATEGY = "hybrid";
      const unrelatedController = new AbortController();
      let seenSignalAbortedAfterExternalAbort = true;

      const completed = await runHybridCompaction(
        buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.9),
        {
          maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
          compactionThreshold: 0.85,
          preserveRecentMessages: 3,
          inactivityMs: 2000,
          totalDeadlineMs: 5000,
          summarize: async (sumReq) => {
            await new Promise((r) => setTimeout(r, 20));
            unrelatedController.abort("client_disconnected");
            await new Promise((r) => setTimeout(r, 20));
            seenSignalAbortedAfterExternalAbort = Boolean(sumReq.signal?.aborted);
            return `${COMPACTION_MODEL_DIGEST_HEADER}\nPrior User Goals & Requests:\n- inspect contextBudget\nRetained Identifiers & Artifacts:\n- File paths: web-ui/lib/contextBudget.ts\n- Git SHAs: 86c8901c6433617cb9abe5db97123a0f52f58c89\n- URLs: https://github.com/test/repo`;
          },
        }
      );
      assert.equal(unrelatedController.signal.aborted, true);
      assert.equal(
        seenSignalAbortedAfterExternalAbort,
        false,
        "external abort must not abort the deadline signal"
      );
      assert.equal(
        completed.modelSummaryUsed,
        true,
        "summarization must complete despite external abort"
      );

      // Deadline signal cuts the pass
      let deadlineSignalAborted = false;
      const cut = await runHybridCompaction(
        buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.9),
        {
          maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
          compactionThreshold: 0.85,
          preserveRecentMessages: 3,
          inactivityMs: 80,
          totalDeadlineMs: 500,
          summarize: (sumReq) =>
            new Promise<never>(() => {
              sumReq.signal?.addEventListener("abort", () => {
                deadlineSignalAborted = true;
              });
            }),
        }
      );
      assert.equal(cut.fallback, true);
      assert.equal(cut.fallbackReason, "timeout");
      assert.equal(deadlineSignalAborted, true, "deadline wrapper signal must abort the pass");
    } finally {
      if (saved === undefined) delete process.env.COMPACTION_STRATEGY;
      else process.env.COMPACTION_STRATEGY = saved;
    }
  });
});

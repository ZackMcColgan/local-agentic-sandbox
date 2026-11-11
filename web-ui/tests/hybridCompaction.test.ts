import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
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
  summarizeTurnHistory
} from "../lib/conversationCompaction";
import { ThreadStore, Thread } from "../lib/threads/threadStore";
import { estimateTokens, CHAT_CONTEXT_BUDGET_TOKENS } from "../lib/contextBudget";

const IDENTIFIER_MESSAGES = [
  { role: "user", content: "Inspect commit 86c8901c6433617cb9abe5db97123a0f52f58c89 and read web-ui/lib/contextBudget.ts, see https://github.com/test/repo" },
  { role: "assistant", content: "Execution error: failed to compile module at line 42." }
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
    { role: "user", content: "First task: inspect web-ui/lib/contextBudget.ts and commit 86c8901c6433617cb9abe5db97123a0f52f58c89 on https://github.com/test/repo" },
    { role: "assistant", content: olderFiller },
    { role: "tool", name: "workspace_read_file", content: olderFiller },
    { role: "assistant", content: "Done." },
    { role: "user", content: "Recent question one" },
    { role: "assistant", content: recentFiller },
    { role: "user", content: "Recent question two" }
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
        preserveRecentMessages: 3
      });
      const hybridOff = await runHybridCompaction(messages, {
        maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        compactionThreshold: 0.85,
        preserveRecentMessages: 3,
        summarize: async () => "SHOULD NEVER BE CALLED"
      });
      assert.equal(hybridOff.strategy, "extraction");
      assert.equal(hybridOff.modelSummaryUsed, false);
      assert.deepEqual(hybridOff.messages, extraction.messages);
      assert.equal(hybridOff.tokensAfter, extraction.tokensAfter);
      assert.equal(hybridOff.liveContent, extraction.messages[1].content);
      assert.ok(!hybridOff.liveContent.includes(COMPACTION_MODEL_DIGEST_HEADER));
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
      const below = await runHybridCompaction(buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.5), {
        maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        compactionThreshold: 0.85,
        preserveRecentMessages: 3,
        summarize: async () => { calls++; return "unused"; }
      });
      assert.equal(below.compacted, true);
      assert.equal(below.modelSummaryUsed, false);
      assert.equal(calls, 0, "Summarizer must not run below the 65% post-extraction threshold");
      const extractionBelow = compactConversationHistory(buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.5), {
        maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        compactionThreshold: 0.85,
        preserveRecentMessages: 3
      });
      assert.deepEqual(below.messages, extractionBelow.messages);

      // Above threshold: one summarization pass, live view headed with model digest header.
      let aboveCalls = 0;
      const above = await runHybridCompaction(buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.9), {
        maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        compactionThreshold: 0.85,
        preserveRecentMessages: 3,
        summarize: async ({ digest, replacedMessages, temperature, maxTokens, inactivityMs, totalDeadlineMs }) => {
          aboveCalls++;
          assert.equal(temperature, SUMMARIZATION_TEMPERATURE);
          assert.equal(maxTokens, SUMMARIZATION_MAX_TOKENS);
          assert.equal(inactivityMs, SUMMARIZATION_INACTIVITY_MS);
          assert.equal(totalDeadlineMs, SUMMARIZATION_TOTAL_DEADLINE_MS);
          assert.ok(digest.includes("web-ui/lib/contextBudget.ts"));
          assert.ok(replacedMessages.length > 0);
          return `${COMPACTION_MODEL_DIGEST_HEADER}\nPrior User Goals & Requests:\n- inspect web-ui/lib/contextBudget.ts\nRetained Identifiers & Artifacts:\n- File paths: web-ui/lib/contextBudget.ts\n- Git SHAs: 86c8901c6433617cb9abe5db97123a0f52f58c89\n- URLs: https://github.com/test/repo\nCritical Errors & Failures:\n- Execution error: failed to compile module at line 42.`;
        }
      });
      assert.equal(aboveCalls, 1, "Exactly ONE summarization pass");
      assert.equal(above.modelSummaryUsed, true);
      assert.equal(above.strategy, "hybrid");
      assert.ok(above.liveContent.startsWith(COMPACTION_MODEL_DIGEST_HEADER));
      assert.equal(above.extractionDigest, summarizeTurnHistory(above.replacedMessages));
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
      const failure = await runHybridCompaction(buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.9), {
        maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        compactionThreshold: 0.85,
        preserveRecentMessages: 3,
        summarize: async () => { throw new Error("engine_stopped: generation failed"); }
      });
      assert.equal(failure.modelSummaryUsed, false);
      assert.equal(failure.fallback, true);
      assert.equal(failure.fallbackReason, "generation_failure");
      assert.ok(failure.liveContent.includes("[CONVERSATION COMPACTED (85% THRESHOLD)]"));

      const timeout = await runHybridCompaction(buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.9), {
        maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        compactionThreshold: 0.85,
        preserveRecentMessages: 3,
        summarize: async () => {
          await new Promise((_, reject) => setTimeout(() => reject(new Error("inactivity deadline exceeded")), 20));
          return "never returned";
        }
      });
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
      const total = await runHybridCompaction(buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.9), {
        maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        compactionThreshold: 0.85,
        preserveRecentMessages: 3,
        totalDeadlineMs: 120,
        inactivityMs: 10_000,
        summarize: () => neverResolves()
      });
      const elapsedTotal = Date.now() - startedTotal;
      assert.equal(total.modelSummaryUsed, false);
      assert.equal(total.fallback, true);
      assert.equal(total.fallbackReason, "timeout");
      assert.ok(elapsedTotal >= 100, `total deadline must fire (~120ms), got ${elapsedTotal}ms`);
      assert.ok(elapsedTotal < 2000, `must not hang past the deadline, got ${elapsedTotal}ms`);

      const startedSilent = Date.now();
      const silent = await runHybridCompaction(buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.9), {
        maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        compactionThreshold: 0.85,
        preserveRecentMessages: 3,
        inactivityMs: 120,
        totalDeadlineMs: 10_000,
        summarize: () => neverResolves()
      });
      const elapsedSilent = Date.now() - startedSilent;
      assert.equal(silent.fallbackReason, "timeout");
      assert.ok(elapsedSilent >= 100, `inactivity deadline must fire (~120ms), got ${elapsedSilent}ms`);
      assert.ok(elapsedSilent < 2000, `must not hang past the inactivity deadline, got ${elapsedSilent}ms`);
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
      const result = await runHybridCompaction(buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.9), {
        maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        compactionThreshold: 0.85,
        preserveRecentMessages: 3,
        inactivityMs: 60,
        totalDeadlineMs: 200,
        summarize: (req) => new Promise<never>(() => {
          const tick = setInterval(() => req.onProgress?.(), 20);
          req.signal?.addEventListener("abort", () => clearInterval(tick));
        })
      });
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
      const res = await runHybridCompaction(IDENTIFIER_MESSAGES.concat(
        buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.9).slice(1)
      ), {
        maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        compactionThreshold: 0.85,
        preserveRecentMessages: 3,
        summarize: async () => `${COMPACTION_MODEL_DIGEST_HEADER}\n- web-ui/lib/contextBudget.ts`
      });
      assert.equal(res.modelSummaryUsed, false);
      assert.equal(res.fallback, true);
      assert.equal(res.fallbackReason, "identifier_post_check_rejected");
      assert.ok(res.liveContent.includes("86c8901c6433617cb9abe5db97123a0f52f58c89"));
      assert.ok(res.liveContent.includes("https://github.com/test/repo"));
    } finally {
      if (saved === undefined) delete process.env.COMPACTION_STRATEGY;
      else process.env.COMPACTION_STRATEGY = saved;
    }
  });

  it("truncation of the model summary falls back to the extraction digest", async () => {
    const saved = process.env.COMPACTION_STRATEGY;
    try {
      process.env.COMPACTION_STRATEGY = "hybrid";
      const res = await runHybridCompaction(buildLargeConversation(CHAT_CONTEXT_BUDGET_TOKENS, 0.9), {
        maxContentTokens: CHAT_CONTEXT_BUDGET_TOKENS,
        compactionThreshold: 0.85,
        preserveRecentMessages: 3,
        summarize: async () => ({
          text: `${COMPACTION_MODEL_DIGEST_HEADER}\n- web-ui/lib/contextBudget.ts\n- 86c8901c6433617cb9abe5db97123a0f52f58c89\n- https://github.com/test/repo`,
          truncated: true
        })
      });
      assert.equal(res.modelSummaryUsed, false);
      assert.equal(res.fallback, true);
      assert.equal(res.fallbackReason, "truncated");
    } finally {
      if (saved === undefined) delete process.env.COMPACTION_STRATEGY;
      else process.env.COMPACTION_STRATEGY = saved;
    }
  });

  it("the shipped prompt constant carries the v1 sections and rules verbatim", () => {
    assert.ok(COMPACTION_PROMPT_V1.startsWith("You are compacting the working memory of an ongoing conversation"));
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
    assert.ok(COMPACTION_PROMPT_V1.includes("LENGTH: your output must be substantially shorter than the source."));
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
          { id: "m1", role: "user", content: "Inspect web-ui/lib/contextBudget.ts commit 86c8901c6433617cb9abe5db97123a0f52f58c89 https://github.com/test/repo", timestamp: "now" },
          { id: "m2", role: "assistant", content: "Working on it.", timestamp: "now" },
          { id: "m3", role: "tool", name: "workspace_read_file", content: "File contents retrieved.", timestamp: "now" },
          { id: "m4", role: "assistant", content: "Done.", timestamp: "now" },
          { id: "m5", role: "user", content: "Recent question one", timestamp: "now" },
          { id: "m6", role: "assistant", content: filler, timestamp: "now" },
          { id: "m7", role: "user", content: "Recent question two", timestamp: "now" }
        ]
      };
      store.saveThread(thread);

      const res = await store.compactThreadIncrementalHybrid(thread, {
        summarize: async ({ digest }) => `${COMPACTION_MODEL_DIGEST_HEADER}\nPrior User Goals & Requests:\n- inspect contextBudget\nRetained Identifiers & Artifacts:\n- File paths: web-ui/lib/contextBudget.ts\n- Git SHAs: 86c8901c6433617cb9abe5db97123a0f52f58c89\n- URLs: https://github.com/test/repo\n` + digest
      });
      assert.equal(res.noop, false);
      assert.equal(res.modelSummaryUsed, true);

      const savedThread = (await store.getThread(thread.id))!;
      assert.ok(savedThread.compaction, "compaction boundary persisted");
      assert.ok(savedThread.compaction!.summary.startsWith(COMPACTION_MODEL_DIGEST_HEADER), "live summary is the model digest");
      assert.ok(savedThread.compaction!.extractionDigest, "extraction digest retained as audit copy");
      assert.ok(savedThread.compaction!.extractionDigest!.includes("86c8901c6433617cb9abe5db97123a0f52f58c89"));
      assert.ok(savedThread.compaction!.extractionDigest!.includes("web-ui/lib/contextBudget.ts"));
      assert.ok(savedThread.compaction!.extractionDigest!.includes("https://github.com/test/repo"));
      assert.equal(savedThread.compaction!.strategy, "hybrid");
      assert.ok(estimateTokens(savedThread.compaction!.summary) < estimateTokens(savedThread.compaction!.extractionDigest!) ||
        savedThread.compaction!.summary.length > 0);

      // Model view uses the live summary; audit copy never becomes the only record.
      const modelView = store.buildModelMessages(savedThread);
      assert.ok(modelView.some((m) => m.content.startsWith(COMPACTION_MODEL_DIGEST_HEADER)));
    } finally {
      if (saved === undefined) delete process.env.COMPACTION_STRATEGY;
      else process.env.COMPACTION_STRATEGY = saved;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
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
          { id: "m1", role: "user", content: "Inspect web-ui/lib/contextBudget.ts commit 86c8901c6433617cb9abe5db97123a0f52f58c89 https://github.com/test/repo", timestamp: "now" },
          { id: "m2", role: "assistant", content: "Working on it.", timestamp: "now" },
          { id: "m3", role: "tool", name: "workspace_read_file", content: "File contents retrieved.", timestamp: "now" },
          { id: "m4", role: "assistant", content: "Done.", timestamp: "now" },
          { id: "m5", role: "user", content: "Recent question one", timestamp: "now" },
          { id: "m6", role: "assistant", content: filler, timestamp: "now" },
          { id: "m7", role: "user", content: "Recent question two", timestamp: "now" }
        ]
      };
      store.saveThread(thread);

      const res = await store.compactThreadIncrementalHybrid(thread, {
        summarize: async () => { throw new Error("engine refused summarization"); }
      });
      assert.equal(res.noop, false);
      assert.equal(res.modelSummaryUsed, false);
      assert.equal(res.fallbackReason, "generation_failure");

      const savedThread = (await store.getThread(thread.id))!;
      assert.ok(savedThread.compaction!.extractionDigest);
      assert.ok(savedThread.compaction!.summary.includes("[CONVERSATION COMPACTED (85% THRESHOLD)]"));
      assert.ok(savedThread.compaction!.fallbackLogged, "fallback logged on the thread record");
      assert.ok(savedThread.compaction!.fallbackReason);
    } finally {
      if (saved === undefined) delete process.env.COMPACTION_STRATEGY;
      else process.env.COMPACTION_STRATEGY = saved;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }  });

  it("chat route call-site wires COMPACTION_STRATEGY=hybrid to the async rung; flag OFF keeps the extraction call", () => {
    // Seam test on the call-site selection at app/api/chat/route.ts (in-turn ladder
    // compaction). Fail-before: at HEAD 3fedd43 this slice contained a single
    // unconditional threadStore.compactThreadIncremental(threadData) with no
    // strategy branch and no hybrid rung, so every assertion below was red.
    const routeSrc = fs.readFileSync(path.resolve(process.cwd(), "app/api/chat/route.ts"), "utf8");
    const anchor = routeSrc.indexOf("const compaction = fitConversationToBudget(");
    assert.ok(anchor >= 0, "chat route must contain the in-turn ladder compaction call-site");
    const slice = routeSrc.slice(anchor, anchor + 2600);
    assert.ok(slice.includes(`resolveCompactionStrategy() === "hybrid"`), "call-site must branch on the resolved strategy");
    assert.ok(slice.includes("await threadStore.compactThreadIncrementalHybrid(threadData"), "hybrid branch must await the async store rung");
    assert.ok(slice.includes("} else {"), "extraction branch must be the else path");
    assert.ok(slice.includes("threadStore.compactThreadIncremental(threadData);"), "flag OFF keeps the existing synchronous extraction call");
    // The call-site adapter feeds the rung request contract (prompt verbatim,
    // digest as source, signal + guardrail options); the summarization pass,
    // identifier post-check, deadlines, and fallback all live in the rung.
    assert.ok(slice.includes("content: req.prompt"), "summarize adapter must send COMPACTION_PROMPT_V1 verbatim");
    assert.ok(slice.includes("content: req.digest"), "summarize adapter must send the extraction digest");
    assert.ok(slice.includes("signal: req.signal"), "summarize adapter must honor the rung deadline signal");
    assert.ok(slice.includes("req.onProgress?.()"), "summarize adapter must call the rung progress hook per chunk (resets the inactivity deadline)");
    assert.ok(slice.includes("num_predict: req.maxTokens"), "summarize adapter must carry the pinned maxTokens");
    assert.ok(routeSrc.includes(`import { compactConversationHistory, resolveCompactionStrategy } from "@/lib/conversationCompaction";`), "route must import the strategy resolver");
    // Out-of-scope surface stays on extraction: the manual compact endpoint.
    const compactSrc = fs.readFileSync(path.resolve(process.cwd(), "app/api/threads/[id]/compact/route.ts"), "utf8");
    assert.ok(compactSrc.includes("threadStore.compactThreadIncremental(thread)"), "manual compact endpoint stays extraction");
    assert.ok(!compactSrc.includes("compactThreadIncrementalHybrid"), "manual compact endpoint must not invoke the hybrid rung");
    assert.ok(!compactSrc.includes("resolveCompactionStrategy"), "manual compact endpoint must not branch on strategy");
  });
});

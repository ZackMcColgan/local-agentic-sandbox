import { test, expect } from "@playwright/test";
import { checkEngineWatchdog, createFreshSession, sendPrompt, awaitTurnCompletion, DEADLINES } from "./helpers";

test.describe("L6: Long-Generation Stability", () => {
  test.beforeEach(async () => {
    await checkEngineWatchdog();
  });

  test("dispatches massive technical specification prompt, generates >16,000 chars (>4,000 tokens), and completes cleanly with zero truncation markers", async ({ page, baseURL }) => {
    const url = baseURL || "http://192.168.50.254";

    // 1. Create fresh session
    const threadId = await createFreshSession(page, url, "L6 Long Generation");

    // 2. Heavy generation prompt designed to produce >4K tokens (>16K chars)
    const heavyPrompt = `Produce a massive, comprehensive technical architecture specification and full Rust implementation guide for a distributed log replication engine.
This must be a long-form document exceeding 5,000 words (>18,000 characters). Do not summarize or abbreviate.

You must provide full, exhaustive Rust source code listings (complete structs, trait implementations, error types, and async worker loops) across the following 8 numbered chapters:
Chapter 1: Memory-Mapped Segment File Storage with zero-copy page cache management and binary header layout.
Chapter 2: Custom TCP Framing Protocol with CRC32 integrity verification and non-blocking socket loops.
Chapter 3: Raft Consensus State Machine with full RPC message definitions, term election, and commit indices.
Chapter 4: Partition Dynamic Rebalancing and consumer group heartbeat state transitions.
Chapter 5: Tiered S3/Blob Cold Storage Archival and index compaction pipelines.
Chapter 6: Concurrent Sparse Skiplist Indexing in memory with dirty page flushing.
Chapter 7: Failure Modes, Poison Pill Quarantining, and Byzantine Network Partition Recovery.
Chapter 8: Complete End-to-End Rust Integration Example connecting all previous modules together.

Elaborate with extensive code blocks and detailed prose.`;

    console.log(`[L6] Dispatching heavy prompt on thread ${threadId}...`);
    await sendPrompt(page, heavyPrompt);

    // 3. Await completion with 10-minute turn deadline (within 12m runner timeout)
    const completedTurn = await awaitTurnCompletion(page, url, threadId, DEADLINES.HEAVY, "l6-heavy-generation");
    const lastMsg = completedTurn.thread.messages[completedTurn.thread.messages.length - 1];

    console.log(`[L6] Turn finished in ${completedTurn.durationSec}s. Output length: ${lastMsg.content?.length} characters.`);

    // 4. Invariants verification
    expect(lastMsg.role).toBe("assistant");
    expect(lastMsg.status).toBe("completed");

    const contentLen = lastMsg.content?.length || 0;
    expect(contentLen).toBeGreaterThanOrEqual(16000);

    // 5. Zero truncation markers
    const content = lastMsg.content || "";
    expect(content).not.toContain("[truncated]");
    expect(content).not.toContain("[earlier tool output truncated]");
    expect(content).not.toContain("[stream truncated]");
  });
});

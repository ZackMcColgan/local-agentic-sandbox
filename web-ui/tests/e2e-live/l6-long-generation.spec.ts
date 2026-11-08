import { test, expect } from "@playwright/test";
import { checkEngineWatchdog, createFreshSession, sendPrompt, awaitTurnCompletion, DEADLINES } from "./helpers";

test.describe("L6: Long-Generation Stability", () => {
  test.beforeEach(async () => {
    await checkEngineWatchdog();
  });

  test("dispatches massive technical specification prompt, generates >16,000 chars (>4,000 tokens), and completes cleanly with zero truncation markers", async ({ page, baseURL }) => {
    test.setTimeout(DEADLINES.WEDGING_LIMIT);
    const url = baseURL || "http://192.168.50.254";

    // 1. Create fresh session
    const threadId = await createFreshSession(page, url, "L6 Long Generation");

    // 2. Heavy generation prompt designed to produce >4K tokens (>16K chars)
    const heavyPrompt = `Write an exhaustive, end-to-end technical architecture and implementation specification for a real-time event streaming engine designed in Rust.

Your specification must contain the following 8 deep-dive chapters in full detail, without omitting sections or using placeholder ellipses:
Chapter 1: Storage Layer Architecture & Memory-Mapped Segment Files (zero-copy page cache, chunk headers, append-only logs).
Chapter 2: Zero-Copy Network Protocol (custom binary framing, CRC32 verification, socket buffering with epoll/kqueue).
Chapter 3: Raft Consensus & Distributed Log Replication (leader election, term changes, snapshotting, quorum commitments).
Chapter 4: Partition Rebalancing & Consumer Group Coordination (heartbeat protocols, dynamic reassignment, state transitions).
Chapter 5: Tiered Cold Storage Engine (S3/GCS asynchronous offloading, index compaction, block indexing).
Chapter 6: High-Performance In-Memory Indexing (sparse skiplists, cache-line-aligned binary search trees, dirty page flushing).
Chapter 7: Failure Modes, Poison Pills & Byzantine Recovery Protocols.
Chapter 8: End-to-End Concrete Rust Implementation Examples with struct definitions, traits, and error handling.

Be exceptionally detailed and thorough for each chapter.`;

    console.log(`[L6] Dispatching heavy prompt on thread ${threadId}...`);
    await sendPrompt(page, heavyPrompt);

    // 3. Await completion with WEDGING_LIMIT deadline
    const completedTurn = await awaitTurnCompletion(page, url, threadId, DEADLINES.WEDGING_LIMIT, "l6-heavy-generation");
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

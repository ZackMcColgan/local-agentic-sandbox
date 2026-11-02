import { NextResponse } from "next/server";
import { ThreadStore } from "@/lib/threads/threadStore";
import { summarizeTurnHistory } from "@/lib/conversationCompaction";
import { estimateTokens, CHAT_CONTEXT_BUDGET_TOKENS } from "@/lib/contextBudget";

const threadStore = new ThreadStore();

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const thread = await threadStore.getThread(id);
    if (!thread) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }

    const messages = thread.messages || [];
    // Need at least system + 4 turns or 6 messages to compact
    if (messages.length <= 4) {
      const tokens = estimateTokens(messages);
      return NextResponse.json({
        noop: true,
        reason: "insufficient_messages",
        tokensBefore: tokens,
        tokensAfter: tokens,
        thread
      });
    }

    // Preserve system prompt and last 4 messages (2 turns)
    const hasSystem = messages[0]?.role === "system";
    const startIdx = hasSystem ? 1 : 0;
    const endIdx = Math.max(startIdx, messages.length - 4);

    if (endIdx <= startIdx) {
      const tokens = estimateTokens(messages);
      return NextResponse.json({
        noop: true,
        reason: "already_compacted",
        tokensBefore: tokens,
        tokensAfter: tokens,
        thread
      });
    }

    const olderMessages = messages.slice(startIdx, endIdx);
    const throughMessage = olderMessages[olderMessages.length - 1];
    const summary = summarizeTurnHistory(olderMessages);

    const tokensBefore = estimateTokens(messages);
    const modelMessages = [
      ...(hasSystem ? [messages[0]] : []),
      { role: "assistant", content: summary },
      ...messages.slice(endIdx)
    ];
    const tokensAfter = estimateTokens(modelMessages);

    threadStore.applyCompactionBoundary(
      thread,
      summary,
      throughMessage.id,
      tokensBefore,
      tokensAfter
    );

    return NextResponse.json({
      noop: false,
      tokensBefore,
      tokensAfter,
      summary,
      throughMessageId: throughMessage.id,
      thread
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { ThreadStore } from "@/lib/threads/threadStore";
import { resolveCompactionStrategy } from "@/lib/conversationCompaction";
import { getLLMProvider } from "@/lib/llm/provider";
import { DEFAULT_PRIMARY_MODEL } from "@/config/models";
import { isValidSafeId } from "@/lib/securityHardening";

const getLlmBaseUrl = () =>
  process.env.LLM_BASE_URL || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!isValidSafeId(id)) {
      return NextResponse.json({ error: "Invalid thread ID" }, { status: 400 });
    }
    const threadStore = new ThreadStore();
    const thread = await threadStore.getThread(id);
    if (!thread) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }

    if (resolveCompactionStrategy() === "hybrid") {
      const activeModel = thread.model || process.env.MODEL_NAME || DEFAULT_PRIMARY_MODEL;
      const provider = getLLMProvider();
      const result = await threadStore.compactThreadIncrementalHybrid(thread, {
        summarize: async (sumReq) => {
          let text = "";
          let truncated = false;
          for await (const chunk of provider.streamChat(getLlmBaseUrl(), {
            model: activeModel,
            messages: [
              { role: "system", content: sumReq.prompt },
              { role: "user", content: sumReq.digest },
            ],
            keep_alive: -1,
            signal: sumReq.signal,
            options: { temperature: sumReq.temperature, num_predict: sumReq.maxTokens },
          })) {
            sumReq.onProgress?.();
            if (chunk.message?.content) text += chunk.message.content;
            if (chunk.finish_reason === "length") truncated = true;
          }
          return { text, truncated };
        },
      });
      return NextResponse.json(result);
    }

    const result = threadStore.compactThreadIncremental(thread);
    return NextResponse.json(result);
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

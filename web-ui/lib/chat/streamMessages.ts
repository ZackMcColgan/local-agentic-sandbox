export function deduplicateStreamMessages<
  T extends { role: string; content: string; traces?: unknown[] },
>(messages: T[]): T[] {
  const out: T[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && m.role === "user" && prev.role === "user" && m.content === prev.content) {
      continue;
    }
    if (prev && m.role === "assistant" && prev.role === "assistant") {
      if (m.content === prev.content) {
        continue;
      }
      if (
        prev.content.trim() &&
        m.content.trim() &&
        (prev.traces?.length || 0) + (m.traces?.length || 0) <= 3
      ) {
        const mergedTraces =
          prev.traces || m.traces ? [...(prev.traces || []), ...(m.traces || [])] : undefined;
        out[out.length - 1] = {
          ...prev,
          ...m,
          ...(mergedTraces ? { traces: mergedTraces } : {}),
          content: `${prev.content}\n\n${m.content}`,
        };
        continue;
      }
    }
    out.push(m);
  }
  return out;
}

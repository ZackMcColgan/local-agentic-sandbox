export interface ParsedToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: Record<string, any>;
  };
}
/**
 * Normalizes an MCP URL to guarantee it points to the /sse SSE endpoint.
 */
export function normalizeMcpUrl(url: string): string {
  if (!url || typeof url !== "string") return "http://127.0.0.1:8080/sse";
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) return "http://127.0.0.1:8080/sse";
  if (trimmed.endsWith("/sse")) {
    return trimmed;
  }
  return `${trimmed}/sse`;
}

/**
 * Extracts function tool calls from raw model text across Qwen XML, tool_call JSON blocks,
 * markdown code blocks, and raw JSON objects.
 */
export function parseToolCallsFromText(
  content: string,
  availableTools?: Set<string> | Map<string, any>
): ParsedToolCall[] {
  if (!content || typeof content !== "string") {
    return [];
  }

  const isToolAllowed = (name: string) => {
    if (!availableTools) return true;
    if (availableTools instanceof Set) return availableTools.has(name);
    if (availableTools instanceof Map) return availableTools.has(name);
    return true;
  };

  const extractedCalls: ParsedToolCall[] = [];

  // 1. Qwen XML syntax: <function=NAME>...</function>
  const funcRegex = /<function(?:=|\s+name=)[\"']?([a-zA-Z0-9_\-]+)[\"']?>([\s\S]*?)<\/function>/gi;
  let match;
  while ((match = funcRegex.exec(content)) !== null) {
    const name = match[1].trim();
    const paramsBlock = match[2];
    const args: Record<string, any> = {};
    const paramRegex = /<parameter(?:=|\s+name=)[\"']?([a-zA-Z0-9_\-]+)[\"']?>([\s\S]*?)<\/parameter>/gi;
    let pMatch;
    while ((pMatch = paramRegex.exec(paramsBlock)) !== null) {
      const key = pMatch[1].trim();
      const rawVal = pMatch[2].trim();
      try {
        args[key] = JSON.parse(rawVal);
      } catch {
        args[key] = rawVal;
      }
    }
    if (isToolAllowed(name)) {
      extractedCalls.push({
        id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        type: "function",
        function: { name, arguments: args }
      });
    }
  }
  if (extractedCalls.length > 0) {
    return extractedCalls;
  }

  // 2. Qwen JSON inside <tool_call>...</tool_call>
  const toolCallBlockRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let blockMatch;
  while ((blockMatch = toolCallBlockRegex.exec(content)) !== null) {
    const inner = blockMatch[1].trim();
    try {
      const parsed = JSON.parse(inner);
      if (parsed && typeof parsed === "object" && parsed.name && isToolAllowed(parsed.name)) {
        extractedCalls.push({
          id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          type: "function",
          function: {
            name: parsed.name,
            arguments: parsed.arguments || {}
          }
        });
      }
    } catch {}
  }
  if (extractedCalls.length > 0) {
    return extractedCalls;
  }

  // 3. Code block ```json ... ```
  const codeBlockMatches = Array.from(content.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi));
  for (const cMatch of codeBlockMatches) {
    try {
      const parsed = JSON.parse((cMatch as RegExpMatchArray)[1].trim());
      if (parsed && typeof parsed === "object" && parsed.name && isToolAllowed(parsed.name)) {
        return [{
          id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          type: "function",
          function: {
            name: parsed.name,
            arguments: parsed.arguments || {}
          }
        }];
      }
    } catch {}
  }

  // 4. Raw JSON object fallback
  const jsonMatch = content.match(/\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0].trim());
      if (parsed && typeof parsed === "object" && parsed.name && isToolAllowed(parsed.name)) {
        return [{
          id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          type: "function",
          function: {
            name: parsed.name,
            arguments: parsed.arguments || {}
          }
        }];
      }
    } catch {}
  }

  return [];
}

/**
 * Strips tool execution XML/JSON tags and returns clean conversational text.
 */
export function cleanResidualToolTags(content: string): string {
  if (!content) return "";
  return content
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<function(?:=|\s+name=)[\"']?[a-zA-Z0-9_\-]+[\"']?>[\s\S]*?<\/function>/gi, "")
    .trim();
}

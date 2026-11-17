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

export const PRIMARY_TOOL_PARAM: Record<string, string> = {
  search_web: "query",
  fetch_webpage_markdown: "url",
  workspace_read_file: "path",
  workspace_write_file: "path",
  workspace_run_command: "command",
  execute_sandboxed_python: "code",
  workspace_grep: "pattern",
  git_checkout_branch: "branch",
  git_commit: "message",
  describe_tool: "tool_name",
  workspace_get_tree: "max_depth",
  verify_container_provenance: "container_id",
  docker_scout_policy_gate: "image_tag"
};

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

  // Strip <think>...</think> and unclosed <think> reasoning blocks so model reasoning
  // is never mistaken for executable tool calls.
  const cleanContent = content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim();

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
  while ((match = funcRegex.exec(cleanContent)) !== null) {
    const name = match[1].trim();
    const paramsBlock = match[2];
    const args: Record<string, any> = {};
    const paramRegex = /<parameter(?:=|\s+name=)[\"']?([a-zA-Z0-9_\-]+)[\"']?>([\s\S]*?)<\/parameter>/gi;
    let pMatch;
    let foundParam = false;
    while ((pMatch = paramRegex.exec(paramsBlock)) !== null) {
      foundParam = true;
      const key = pMatch[1].trim();
      const rawVal = pMatch[2].trim();
      try {
        args[key] = JSON.parse(rawVal);
      } catch {
        args[key] = rawVal;
      }
    }

    // Defensive fallback: if no <parameter> tags present, extract raw value or JSON
    if (!foundParam && paramsBlock.trim()) {
      const trimmedBlock = paramsBlock.trim();
      try {
        const parsedJson = JSON.parse(trimmedBlock);
        if (parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson)) {
          Object.assign(args, parsedJson);
        } else if (PRIMARY_TOOL_PARAM[name]) {
          args[PRIMARY_TOOL_PARAM[name]] = parsedJson;
        }
      } catch {
        if (PRIMARY_TOOL_PARAM[name]) {
          args[PRIMARY_TOOL_PARAM[name]] = trimmedBlock;
        }
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
  while ((blockMatch = toolCallBlockRegex.exec(cleanContent)) !== null) {
    const inner = blockMatch[1].trim();
    try {
      const parsed = JSON.parse(inner);
      if (parsed && typeof parsed === "object" && parsed.name && isToolAllowed(parsed.name)) {
        let finalArgs = parsed.arguments || {};
        if (typeof finalArgs === "string" && PRIMARY_TOOL_PARAM[parsed.name]) {
          finalArgs = { [PRIMARY_TOOL_PARAM[parsed.name]]: finalArgs };
        }
        extractedCalls.push({
          id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          type: "function",
          function: {
            name: parsed.name,
            arguments: finalArgs
          }
        });
      }
    } catch {}
  }
  if (extractedCalls.length > 0) {
    return extractedCalls;
  }

  // 3. Code block ```json ... ```
  const codeBlockMatches = Array.from(cleanContent.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi));
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
  const jsonMatch = cleanContent.match(/\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/);
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
    .replace(/<tool_call>[\s\S]*$/gi, "")
    .replace(/<function(?:=|\s+name=)[\"']?[a-zA-Z0-9_\-]+[\"']?>[\s\S]*?<\/function>/gi, "")
    .replace(/<\/?function[^>]*>/gi, "")
    .trim();
}

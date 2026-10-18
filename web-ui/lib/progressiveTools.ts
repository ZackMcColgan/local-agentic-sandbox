/**
 * Progressive Tool Disclosure Architecture
 *
 * Layer 1: Compact tool schemas with sharp one-liners (~300 tokens total)
 * Layer 2: On-demand 'describe_tool' meta-tool returning full schemas on request
 *
 * Saves >= 1,000 tokens of context overhead on every request.
 */

import { estimateTokens } from "./contextBudget";

export interface ToolFunctionSpec {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
  inputSchema?: Record<string, any>;
}

export interface McpToolItem {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

export const DESCRIBE_TOOL_NAME = "describe_tool";

export const DESCRIBE_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: DESCRIBE_TOOL_NAME,
    description: "Retrieve the full JSON schema and parameter specification for a tool before first use.",
    parameters: {
      type: "object",
      properties: {
        tool_name: {
          type: "string",
          description: "The name of the tool to describe (e.g. 'workspace_write_file', 'execute_sandboxed_python')"
        }
      },
      required: ["tool_name"],
      additionalProperties: false
    }
  }
};

export const KNOWN_ONE_LINERS: Record<string, string> = {
  search_web: "Search internet with DuckDuckGo; returns clean markdown.",
  fetch_webpage_markdown: "Fetch public URL and convert content to clean markdown.",
  workspace_get_tree: "Retrieve directory tree excluding node_modules and .git.",
  workspace_grep: "Fast regex/substring search across codebase.",
  workspace_read_file: "Read file with line numbers.",
  workspace_write_file: "Atomically write code, Markdown, or SVG files.",
  workspace_run_command: "Execute test/build commands in sandbox container.",
  git_status: "Inspect git branch status and unstaged changes.",
  git_diff: "Inspect branch unified diff.",
  git_checkout_branch: "Create or switch git branch.",
  git_commit: "Commit staged modifications with semantic message.",
  execute_sandboxed_python: "Run Python code inside isolated sandbox container.",
  verify_container_provenance: "Inspect container security boundaries and SLSA attestations.",
  docker_scout_policy_gate: "Evaluate container CVE vulnerabilities against policy."
};

export const DEFAULT_TOOL_SCHEMAS: Record<string, ToolFunctionSpec> = {
  search_web: {
    name: "search_web",
    description: "Search internet with DuckDuckGo; returns clean markdown.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query text to execute" }
      },
      required: ["query"]
    }
  },
  fetch_webpage_markdown: {
    name: "fetch_webpage_markdown",
    description: "Fetch public URL and convert content to clean markdown.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Fully qualified public HTTP/HTTPS URL" }
      },
      required: ["url"]
    }
  },
  workspace_get_tree: {
    name: "workspace_get_tree",
    description: "Retrieve directory tree excluding node_modules and .git.",
    parameters: {
      type: "object",
      properties: {
        max_depth: { type: "number", description: "Maximum directory depth" }
      }
    }
  },
  workspace_grep: {
    name: "workspace_grep",
    description: "Fast regex/substring search across codebase.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search pattern" }
      },
      required: ["pattern"]
    }
  },
  workspace_read_file: {
    name: "workspace_read_file",
    description: "Read file with line numbers.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path" }
      },
      required: ["path"]
    }
  },
  workspace_write_file: {
    name: "workspace_write_file",
    description: "Atomically write code, Markdown, or SVG files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path" },
        content: { type: "string", description: "File content" }
      },
      required: ["path", "content"]
    }
  },
  workspace_run_command: {
    name: "workspace_run_command",
    description: "Execute test/build commands in sandbox container.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command" }
      },
      required: ["command"]
    }
  },
  git_status: {
    name: "git_status",
    description: "Inspect git branch status and unstaged changes.",
    parameters: { type: "object" }
  },
  git_diff: {
    name: "git_diff",
    description: "Inspect branch unified diff.",
    parameters: { type: "object" }
  },
  git_checkout_branch: {
    name: "git_checkout_branch",
    description: "Create or switch git branch.",
    parameters: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Branch name" }
      },
      required: ["branch"]
    }
  },
  git_commit: {
    name: "git_commit",
    description: "Commit staged modifications with semantic message.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Commit message" }
      },
      required: ["message"]
    }
  },
  execute_sandboxed_python: {
    name: "execute_sandboxed_python",
    description: "Run Python code inside isolated sandbox container.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "Python code" }
      },
      required: ["code"]
    }
  },
  verify_container_provenance: {
    name: "verify_container_provenance",
    description: "Inspect container security boundaries and SLSA attestations.",
    parameters: { type: "object" }
  },
  docker_scout_policy_gate: {
    name: "docker_scout_policy_gate",
    description: "Evaluate container CVE vulnerabilities against policy.",
    parameters: { type: "object" }
  }
};

/**
 * Trims verbose descriptions into a clean, sharp one-liner <= 120 chars.
 */
export function toOneLiner(description?: string): string {
  if (!description) return "";
  const firstSentence = description.split(/\.\s+/)[0].trim();
  const clean = firstSentence.replace(/\s+/g, " ");
  if (clean.length <= 80) {
    return clean.endsWith(".") ? clean : `${clean}.`;
  }
  return clean.slice(0, 77).trim() + "...";
}

/**
 * Builds Layer 1 lightweight tool definitions from raw MCP tools or full tool functions.
 * Layer 1 tools keep names and one-liner descriptions with flexible open schemas (~300 tokens total).
 */
export function buildLayer1Tools(tools: Array<McpToolItem | { type?: string; function?: ToolFunctionSpec }>): any[] {
  const layer1: any[] = [DESCRIBE_TOOL_SCHEMA];
  const listToIterate = tools.length > 0 ? tools : Object.keys(KNOWN_ONE_LINERS).map(name => ({ name }));

  for (const t of listToIterate) {
    let name = "";
    let description = "";

    if ("function" in t && t.function) {
      name = t.function.name;
      description = t.function.description || "";
    } else if ("name" in t) {
      name = (t as McpToolItem).name;
      description = (t as McpToolItem).description || "";
    }

    if (!name || name === DESCRIBE_TOOL_NAME) continue;

    const oneLiner = KNOWN_ONE_LINERS[name] || toOneLiner(description);

    layer1.push({
      type: "function",
      function: {
        name,
        description: oneLiner,
        parameters: { type: "object" }
      }
    });
  }

  return layer1;
}

/**
 * Creates a Map of tool name -> full schema for Layer 2 on-demand resolution.
 */
export function buildToolRegistry(
  tools: Array<McpToolItem | { type?: string; function?: ToolFunctionSpec }>
): Map<string, ToolFunctionSpec> {
  const map = new Map<string, ToolFunctionSpec>();

  for (const t of tools) {
    if ("function" in t && t.function) {
      map.set(t.function.name, {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters || {}
      });
    } else if ("name" in t) {
      const mcp = t as McpToolItem;
      map.set(mcp.name, {
        name: mcp.name,
        description: mcp.description,
        parameters: mcp.inputSchema || {}
      });
    }
  }

  return map;
}

/**
 * Layer 2: On-demand resolution of full tool schema.
 */
export function describeTool(
  toolName: string,
  registry: Map<string, ToolFunctionSpec> | Record<string, ToolFunctionSpec>
): { tool?: ToolFunctionSpec; error?: string } {
  if (!toolName) {
    return { error: "Missing required argument: tool_name" };
  }

  const spec = registry instanceof Map ? registry.get(toolName) : registry[toolName];
  if (spec) {
    return { tool: spec };
  }

  if (DEFAULT_TOOL_SCHEMAS[toolName]) {
    return { tool: DEFAULT_TOOL_SCHEMAS[toolName] };
  }

  const available = registry instanceof Map ? Array.from(registry.keys()) : Object.keys(registry);
  const displayList = available.length > 0 ? available : Object.keys(KNOWN_ONE_LINERS);
  return {
    error: `Unknown tool '${toolName}'. Available tools: ${displayList.join(", ")}`
  };
}

/**
 * Calculates token reduction between full schema tools and Layer 1 progressive disclosure tools.
 */
export function calculateToolTokenSavings(
  fullTools: any[],
  layer1Tools: any[]
): { fullTokens: number; layer1Tokens: number; savings: number; percentage: number } {
  const fullTokens = estimateTokens(JSON.stringify(fullTools));
  const layer1Tokens = estimateTokens(JSON.stringify(layer1Tools));
  const savings = Math.max(0, fullTokens - layer1Tokens);
  const percentage = fullTokens > 0 ? Math.round((savings / fullTokens) * 100) : 0;

  return { fullTokens, layer1Tokens, savings, percentage };
}

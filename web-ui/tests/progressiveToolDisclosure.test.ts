import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DESCRIBE_TOOL_NAME,
  DESCRIBE_TOOL_SCHEMA,
  buildLayer1Tools,
  buildToolRegistry,
  describeTool,
  calculateToolTokenSavings,
  toOneLiner,
  KNOWN_ONE_LINERS,
  deriveToolSignature
} from "../lib/progressiveTools";
import { z } from "zod";
import { estimateTokens } from "../lib/contextBudget";

describe("Progressive Tool Disclosure Suite (Fix D1)", () => {
  const sampleMcpTools = [
    {
      name: "search_web",
      description: "Search the internet using DuckDuckGo. Automatically fetches and attaches clean markdown for the most informative top result in 'top_result_content'. Use this whenever the user asks about real-time information, latest documentation, weather forecasts, external packages, or general web lookups.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query text to execute on search engine" },
          max_results: { type: "number", description: "Maximum number of search result summaries to return (default: 5, range: 1-10)" },
          time_range: { type: "string", enum: ["d", "w", "m", "y", "all"], description: "Time range filter for search results" },
          safe_search: { type: "string", enum: ["strict", "moderate", "off"], description: "SafeSearch filtering level" },
          region: { type: "string", description: "Regional geographic search preference code (e.g. 'us-en', 'uk-en')" }
        },
        required: ["query"]
      }
    },
    {
      name: "fetch_webpage_markdown",
      description: "Fetch any public URL and convert its content into clean markdown. Use this to read documentation, inspect web pages, or scrape articles.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Fully qualified public HTTP/HTTPS URL to retrieve" },
          timeout_sec: { type: "number", description: "HTTP request timeout in seconds (default: 15, max: 60)" },
          extract_main_content: { type: "boolean", description: "Whether to strip navigation, footers, headers, and ads" },
          max_length_chars: { type: "number", description: "Maximum characters of markdown to return (default: 4000)" }
        },
        required: ["url"]
      }
    },
    {
      name: "workspace_get_tree",
      description: "Retrieve repository directory tree skipping node_modules and .git. Returns hierarchical JSON representation.",
      inputSchema: {
        type: "object",
        properties: {
          max_depth: { type: "number", description: "Maximum directory depth to traverse (default: 4)" },
          subpath: { type: "string", description: "Relative subfolder path to root traversal from" },
          include_hidden: { type: "boolean", description: "Include dotfiles and hidden system folders" },
          file_extensions: { type: "array", items: { type: "string" }, description: "Filter tree to specific file extensions" }
        }
      }
    },
    {
      name: "workspace_grep",
      description: "Fast regex/substring search across codebase. Returns matches with file paths and line numbers.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression or literal string pattern to search across codebase" },
          path_filter: { type: "string", description: "Glob or path substring filter to constrain file search scope" },
          case_sensitive: { type: "boolean", description: "Case sensitive matching (default: false)" },
          max_results: { type: "number", description: "Maximum number of matched lines to return (default: 50)" },
          context_lines: { type: "number", description: "Number of leading and trailing context lines to include" }
        },
        required: ["pattern"]
      }
    },
    {
      name: "workspace_read_file",
      description: "Read files with line numbers. Essential for inspecting source code, configs, and test files.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to file in workspace" },
          start_line: { type: "number", description: "1-indexed start line number for range view" },
          end_line: { type: "number", description: "1-indexed end line number for range view" },
          encoding: { type: "string", enum: ["utf-8", "ascii", "base64"], description: "File content character encoding" }
        },
        required: ["path"]
      }
    },
    {
      name: "workspace_write_file",
      description: "Atomically write code, Markdown documentation, and SVG vector diagrams (.svg). Replaces complete content.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to target file in workspace" },
          content: { type: "string", description: "Complete raw file content string to write atomically" },
          backup: { type: "boolean", description: "Whether to create a backup file before writing" },
          mode: { type: "string", description: "File permissions mode octal (e.g. '0644', '0755')" },
          create_directories: { type: "boolean", description: "Automatically create intermediate directories if missing" }
        },
        required: ["path", "content"]
      }
    },
    {
      name: "workspace_run_command",
      description: "Execute commands (pytest, npm test, cargo, bash) and inspect exit codes & stderr. Runs in sandbox container.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command string to execute in workspace root" },
          cwd: { type: "string", description: "Working directory relative to workspace root" },
          timeout_sec: { type: "number", description: "Command timeout in seconds (default: 30, max: 300)" },
          env_vars: { type: "object", additionalProperties: { type: "string" }, description: "Custom environment variables to pass" },
          capture_output: { type: "boolean", description: "Whether to capture stdout and stderr stream buffers" }
        },
        required: ["command"]
      }
    },
    {
      name: "git_status",
      description: "Inspect branch status, unstaged changes, and untracked files.",
      inputSchema: {
        type: "object",
        properties: {
          include_untracked: { type: "boolean", description: "Include untracked newly created files in output" },
          short_format: { type: "boolean", description: "Return git status in porcelain short format" }
        }
      }
    },
    {
      name: "git_diff",
      description: "Inspect branch unified diff. Shows added, deleted, and modified lines.",
      inputSchema: {
        type: "object",
        properties: {
          staged: { type: "boolean", description: "Show staged changes instead of working tree modifications" },
          file_path: { type: "string", description: "Limit diff to specific file or subdirectory path" },
          context_lines: { type: "number", description: "Number of context lines surrounding unified diff hunks" }
        }
      }
    },
    {
      name: "git_checkout_branch",
      description: "Create or switch to an autonomous branch (e.g. agent/feat-xyz).",
      inputSchema: {
        type: "object",
        properties: {
          branch: { type: "string", description: "Name of target git branch" },
          create_new: { type: "boolean", description: "Create branch if it does not already exist" },
          start_point: { type: "string", description: "Starting commit or branch for new branch creation" }
        },
        required: ["branch"]
      }
    },
    {
      name: "git_commit",
      description: "Commit staged modifications with semantic messages.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Git commit message following conventional commit guidelines" },
          all: { type: "boolean", description: "Stage all tracked modified files before committing" },
          amend: { type: "boolean", description: "Amend previous commit instead of creating new commit" }
        },
        required: ["message"]
      }
    },
    {
      name: "execute_sandboxed_python",
      description: "Run Python code and test assertions inside a zero-trust, unprivileged Linux container sandbox (cap_drop ALL, read-only rootfs).",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "Python 3 source code script to execute inside sandbox" },
          timeout_sec: { type: "number", description: "Execution timeout in seconds (default: 15, max: 60)" },
          packages: { type: "array", items: { type: "string" }, description: "Pre-installed PyPI packages required" },
          memory_limit_mb: { type: "number", description: "Memory resource limit in megabytes (default: 512)" },
          network_enabled: { type: "boolean", description: "Allow outbound network connectivity (default: false)" }
        },
        required: ["code"]
      }
    },
    {
      name: "verify_container_provenance",
      description: "Inspect runtime container security boundaries and SLSA attestations. Verifies signatures and isolation.",
      inputSchema: {
        type: "object",
        properties: {
          container_id: { type: "string", description: "ID of container instance to inspect" },
          require_slsa_level: { type: "number", description: "Minimum acceptable SLSA verification level (1-4)" },
          strict_enforcement: { type: "boolean", description: "Fail validation on non-verifiable cryptographic signatures" },
          allow_self_signed: { type: "boolean", description: "Permit internal development root CA certificate chains" }
        },
        required: ["container_id"]
      }
    },
    {
      name: "docker_scout_policy_gate",
      description: "Evaluate container CVE vulnerabilities against security policies. Blocks deployment on critical/high CVEs.",
      inputSchema: {
        type: "object",
        properties: {
          image_tag: { type: "string", description: "Full OCI container image tag to scan and evaluate against policy" },
          severity_threshold: { type: "string", enum: ["low", "medium", "high", "critical"], description: "Maximum allowable CVE severity threshold" },
          fail_on_cve: { type: "boolean", description: "Return non-zero exit status if violations found" },
          policy_file: { type: "string", description: "Custom OPA or Docker Scout policy specification file path" },
          ignore_cve_list: { type: "array", items: { type: "string" }, description: "List of CVE identifiers explicitly exempt from policy" }
        },
        required: ["image_tag"]
      }
    }
  ];

  it("converts descriptions into concise one-liners <= 120 chars", () => {
    const raw = "Search the internet using DuckDuckGo. Automatically fetches and attaches clean markdown for the most informative top result in 'top_result_content'. Use this whenever the user asks about real-time information.";
    const oneLiner = toOneLiner(raw);
    assert.ok(oneLiner.length <= 120, `Expected <= 120 chars, got ${oneLiner.length}`);
    assert.equal(oneLiner, "Search the internet using DuckDuckGo.");
  });

  it("builds Layer 1 tools with describe_tool schema and sharp one-liners", () => {
    const layer1 = buildLayer1Tools(sampleMcpTools);
    assert.equal(layer1.length, sampleMcpTools.length + 1, "Layer 1 must include describe_tool + all tools");

    const describeToolEntry = layer1.find((t) => t.function?.name === DESCRIBE_TOOL_NAME);
    assert.ok(describeToolEntry, "Layer 1 must include describe_tool schema");
    assert.equal(describeToolEntry.function.name, DESCRIBE_TOOL_NAME);

    const writeTool = layer1.find((t) => t.function?.name === "workspace_write_file");
    assert.ok(writeTool, "Layer 1 must include workspace_write_file");
    assert.ok(writeTool.function.description.length <= 120);
    assert.equal(writeTool.function.parameters.type, "object");
  });

  it("achieves >= 1,000 token reduction between full schemas and Layer 1 disclosure", () => {
    const fullToolsFormatted = sampleMcpTools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema
      }
    }));

    const layer1 = buildLayer1Tools(sampleMcpTools);
    const savings = calculateToolTokenSavings(fullToolsFormatted, layer1);

    assert.ok(
      savings.savings >= 1000,
      `Expected at least 1,000 tokens saved, but saved ${savings.savings} tokens (full: ${savings.fullTokens}, layer1: ${savings.layer1Tokens})`
    );
    assert.ok(
      savings.layer1Tokens <= 700,
      `Layer 1 tools must be <= 700 tokens, got ${savings.layer1Tokens}`
    );
  });

  it("resolves full tool schema on demand via describeTool (Layer 2)", () => {
    const registry = buildToolRegistry(sampleMcpTools);
    const res = describeTool("workspace_write_file", registry);

    assert.ok(!res.error, `Unexpected error: ${res.error}`);
    assert.ok(res.tool, "Expected tool spec to be returned");
    assert.equal(res.tool.name, "workspace_write_file");
    assert.deepEqual(res.tool.parameters?.required, ["path", "content"]);
    assert.ok(res.tool.parameters?.properties?.content);
  });

  it("returns helpful error with available tools for unknown tool request", () => {
    const registry = buildToolRegistry(sampleMcpTools);
    const res = describeTool("unknown_nonexistent_tool", registry);

    assert.ok(res.error, "Expected error for unknown tool");
    assert.ok(res.error.includes("Available tools:"));
    assert.ok(res.error.includes("workspace_write_file"));
  });

  describe("Bug 1: Layer 1 Parameter Signatures & search_web Execution", () => {
    it("includes parameter signatures in KNOWN_ONE_LINERS descriptions", () => {
      assert.ok(
        KNOWN_ONE_LINERS.search_web?.startsWith("search_web(query"),
        `search_web must declare signature search_web(query...), got: ${KNOWN_ONE_LINERS.search_web}`
      );
      assert.ok(
        KNOWN_ONE_LINERS.fetch_webpage_markdown?.startsWith("fetch_webpage_markdown(url)"),
        `fetch_webpage_markdown must declare signature, got: ${KNOWN_ONE_LINERS.fetch_webpage_markdown}`
      );
      assert.ok(
        KNOWN_ONE_LINERS.workspace_read_file?.startsWith("workspace_read_file(path"),
        `workspace_read_file must declare signature, got: ${KNOWN_ONE_LINERS.workspace_read_file}`
      );
      assert.ok(
        KNOWN_ONE_LINERS.workspace_write_file?.startsWith("workspace_write_file(path, content)"),
        `workspace_write_file must declare signature, got: ${KNOWN_ONE_LINERS.workspace_write_file}`
      );
      assert.ok(
        KNOWN_ONE_LINERS.workspace_run_command?.startsWith("workspace_run_command(command"),
        `workspace_run_command must declare signature, got: ${KNOWN_ONE_LINERS.workspace_run_command}`
      );
      assert.ok(
        KNOWN_ONE_LINERS.git_checkout_branch?.startsWith("git_checkout_branch(branch)"),
        `git_checkout_branch must declare signature, got: ${KNOWN_ONE_LINERS.git_checkout_branch}`
      );
      assert.ok(
        KNOWN_ONE_LINERS.git_commit?.startsWith("git_commit(message)"),
        `git_commit must declare signature, got: ${KNOWN_ONE_LINERS.git_commit}`
      );
      assert.ok(
        KNOWN_ONE_LINERS.execute_sandboxed_python?.startsWith("execute_sandboxed_python(code)"),
        `execute_sandboxed_python must declare signature, got: ${KNOWN_ONE_LINERS.execute_sandboxed_python}`
      );
      assert.ok(
        KNOWN_ONE_LINERS.verify_container_provenance?.startsWith("verify_container_provenance(container_id)"),
        `verify_container_provenance must declare signature, got: ${KNOWN_ONE_LINERS.verify_container_provenance}`
      );
      assert.ok(
        KNOWN_ONE_LINERS.docker_scout_policy_gate?.startsWith("docker_scout_policy_gate(image_tag)"),
        `docker_scout_policy_gate must declare signature, got: ${KNOWN_ONE_LINERS.docker_scout_policy_gate}`
      );
    });

    it("ensures search_web signature produces arguments that satisfy MCP zod schema, rejecting empty object {}", () => {
      const searchWebMcpSchema = z.object({
        query: z.string().describe("Search keywords or technical question"),
        limit: z.number().min(1).max(10).optional().default(5).describe("Maximum number of search results to return")
      });

      // The Bug 1 symptom: empty arguments {} from blind call fail zod validation
      const emptyCallResult = searchWebMcpSchema.safeParse({});
      assert.equal(emptyCallResult.success, false, "Empty arguments {} MUST fail search_web schema validation");

      // Extract parameter signature from Layer 1 description
      const layer1 = buildLayer1Tools(sampleMcpTools);
      const searchWebLayer1 = layer1.find((t) => t.function?.name === "search_web");
      assert.ok(searchWebLayer1, "search_web must exist in Layer 1");
      const desc = searchWebLayer1.function.description;
      assert.ok(desc.includes("query"), "search_web description must specify required parameter 'query'");

      // Valid call with query parameter satisfies schema
      const validCall = searchWebMcpSchema.safeParse({ query: "tomorrow's weather in Spanish Fort AL" });
      assert.equal(validCall.success, true, "Call with query must satisfy search_web schema");
      if (validCall.success) {
        assert.equal(validCall.data.query, "tomorrow's weather in Spanish Fort AL");
        assert.equal(validCall.data.limit, 5); // default applied
      }
    });

    it("every tool in sampleMcpTools with required parameters has all required parameters in its signature", () => {
      const layer1 = buildLayer1Tools(sampleMcpTools);

      for (const tool of sampleMcpTools) {
        const requiredParams = tool.inputSchema?.required || [];
        if (requiredParams.length === 0) continue;

        const layer1Entry = layer1.find((t) => t.function?.name === tool.name);
        assert.ok(layer1Entry, `Layer 1 must contain ${tool.name}`);
        const desc = layer1Entry.function.description;

        for (const req of requiredParams) {
          assert.ok(
            desc.includes(req),
            `Layer 1 description for ${tool.name} must include required parameter '${req}', got: "${desc}"`
          );
        }
      }
    });

    it("buildLayer1Tools derives parameter signatures dynamically from inputSchema when not in KNOWN_ONE_LINERS", () => {
      const customTool = {
        name: "custom_analyzer",
        description: "Analyze system logs and report anomalies.",
        inputSchema: {
          type: "object",
          properties: {
            log_file: { type: "string" },
            max_lines: { type: "number" }
          },
          required: ["log_file"]
        }
      };

      const layer1 = buildLayer1Tools([customTool]);
      const entry = layer1.find((t) => t.function?.name === "custom_analyzer");
      assert.ok(entry, "custom_analyzer must be in layer 1");
      assert.ok(
        entry.function.description.startsWith("custom_analyzer(log_file, max_lines?):"),
        `Expected derived signature custom_analyzer(log_file, max_lines?), got: "${entry.function.description}"`
      );
    });

    it("maintains >= 1,000 token savings and <= 700 Layer 1 tokens with signatures added", () => {
      const fullToolsFormatted = sampleMcpTools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema
        }
      }));

      const layer1 = buildLayer1Tools(sampleMcpTools);
      const savings = calculateToolTokenSavings(fullToolsFormatted, layer1);

      assert.ok(
        savings.savings >= 1000,
        `Expected >= 1000 tokens saved with signatures, got ${savings.savings}`
      );
      assert.ok(
        savings.layer1Tokens <= 700,
        `Layer 1 tokens with signatures must be <= 700, got ${savings.layer1Tokens}`
      );
    });
  });
});


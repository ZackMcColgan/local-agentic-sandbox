import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compactConversationHistory,
  summarizeTurnHistory,
  extractIdentifiersAndErrors,
  DEFAULT_COMPACTION_THRESHOLD
} from "../lib/conversationCompaction";
import { estimateTokens } from "../lib/contextBudget";

describe("Conversation Compaction at 85% Suite (Fix D3)", () => {
  it("does not compact when context utilization is below 85% threshold", () => {
    const messages = [
      { role: "system", content: "You are an assistant." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there! How can I help you today?" }
    ];

    const res = compactConversationHistory(messages, { maxContentTokens: 6000 });
    assert.equal(res.compacted, false);
    assert.equal(res.messages.length, messages.length);
    assert.equal(res.tokensAfter, res.tokensBefore);
  });

  it("compacts older turns when token count reaches >= 85% of budget", () => {
    const systemMsg = { role: "system", content: "System instructions for autonomous agent." };
    // Build a large conversation that exceeds 85% of 2000 tokens (1700 tokens = ~6800 chars)
    const longContent = "A".repeat(400);

    const messages = [
      systemMsg,
      { role: "user", content: "First task: research kubernetes deployment" },
      { role: "assistant", content: "I will use search_web to look up deployment specs.", tool_calls: [{ function: { name: "search_web" } }] },
      { role: "tool", name: "search_web", content: longContent },
      { role: "assistant", content: "Found k8s deployment guidelines." },
      { role: "user", content: "Second task: inspect workspace repo structure" },
      { role: "assistant", content: "I will call workspace_get_tree.", tool_calls: [{ function: { name: "workspace_get_tree" } }] },
      { role: "tool", name: "workspace_get_tree", content: longContent },
      { role: "assistant", content: "Workspace structure retrieved." },
      { role: "user", content: "Third task: write deployment.yaml file" },
      { role: "assistant", content: "I will write deployment file.", tool_calls: [{ function: { name: "workspace_write_file" } }] },
      { role: "tool", name: "workspace_write_file", content: "File written successfully." },
      { role: "assistant", content: "Deployment manifest created." },
      // Recent turns that must be preserved verbatim
      { role: "user", content: "Now check cluster health status" },
      { role: "assistant", content: "Checking cluster health..." },
      { role: "user", content: "And draw an architecture diagram" }
    ];

    const maxContentTokens = 400; // 85% is 340 tokens
    const tokensBefore = estimateTokens(messages);
    assert.ok(tokensBefore >= 340, `Expected >= 340 tokens, got ${tokensBefore}`);

    const res = compactConversationHistory(messages, {
      maxContentTokens,
      compactionThreshold: 0.85,
      preserveRecentMessages: 3
    });

    assert.equal(res.compacted, true);
    assert.ok(res.tokensAfter < res.tokensBefore, "Compacted messages must consume fewer tokens");

    // Invariant 1: System prompt preserved at index 0
    assert.equal(res.messages[0].role, "system");
    assert.equal(res.messages[0].content, systemMsg.content);

    // Invariant 2: Compaction summary injected at index 1
    assert.equal(res.messages[1].role, "assistant");
    assert.ok(
      res.messages[1].content.includes("[CONVERSATION COMPACTED (85% THRESHOLD)]"),
      "Summary message must contain compaction header"
    );
    assert.ok(res.messages[1].content.includes("search_web") || res.messages[1].content.includes("workspace_get_tree"));

    // Invariant 3: Last 3 recent messages preserved verbatim at tail
    const tail = res.messages.slice(-3);
    assert.equal(tail[0].content, "Now check cluster health status");
    assert.equal(tail[1].content, "Checking cluster health...");
    assert.equal(tail[2].content, "And draw an architecture diagram");
  });

  it("extracts structured summaries with goals, tools, and outcomes", () => {
    const older = [
      { role: "user", content: "Please build a REST API in Go" },
      { role: "assistant", content: "Setting up server", tool_calls: [{ function: { name: "workspace_run_command" } }] },
      { role: "tool", name: "workspace_run_command", content: "go mod init api" },
      { role: "assistant", content: "API server scaffolded successfully" }
    ];

    const summary = summarizeTurnHistory(older);
    assert.ok(summary.includes("REST API in Go"));
    assert.ok(summary.includes("workspace_run_command"));
    assert.ok(summary.includes("API server scaffolded successfully"));
  });

  it("handles short or empty conversation arrays gracefully without mutating input", () => {
    const empty: any[] = [];
    const resEmpty = compactConversationHistory(empty);
    assert.equal(resEmpty.compacted, false);
    assert.equal(resEmpty.messages.length, 0);

    const single = [{ role: "user", content: "hello" }];
    const resSingle = compactConversationHistory(single);
    assert.equal(resSingle.compacted, false);
    assert.equal(resSingle.messages.length, 1);
  });

  it("extracts identifiers (file paths, git SHAs, URLs, and errors) into compaction summary", () => {
    const messages = [
      { role: "user", content: "Inspect repo status and commit sha 86c8901c6433617cb9abe5db97123a0f52f58c89" },
      { role: "assistant", content: "I will read web-ui/lib/contextBudget.ts and check https://github.com/test/repo." },
      { role: "tool", name: "read_file", content: "Read web-ui/lib/contextBudget.ts successfully." },
      { role: "assistant", content: "Execution error: failed to compile module at line 42." }
    ];
    const extracted = extractIdentifiersAndErrors(messages);
    assert.ok(extracted.filePaths.includes("web-ui/lib/contextBudget.ts"));
    assert.ok(extracted.gitShas.includes("86c8901c6433617cb9abe5db97123a0f52f58c89"));
    assert.ok(extracted.urls.some((u: string) => u.startsWith("https://github.com/test/repo")));
    assert.ok(extracted.errorLines.some((l: string) => l.includes("failed to compile module")));

    const summary = summarizeTurnHistory(messages);
    assert.ok(summary.includes("web-ui/lib/contextBudget.ts"));
    assert.ok(summary.includes("86c8901c6433617cb9abe5db97123a0f52f58c89"));
    assert.ok(summary.includes("https://github.com/test/repo"));
    assert.ok(summary.includes("failed to compile module"));
  });

  it("preserves all 20 git SHAs and 30 file paths (including space-separated and Windows paths) verbatim under compaction", () => {
    // 20 distinct git SHAs (10 7-char short SHAs and 10 40-char full SHAs)
    const shortShas = [
      "a1b2c3d", "e4f5a6b", "c7d8e9f", "1a2b3c4", "5d6e7f8",
      "9a0b1c2", "3d4e5f6", "7a8b9c0", "2e3f4a5", "6b7c8d9"
    ];
    const fullShas = [
      "0123456789abcdef0123456789abcdef01234567",
      "123456789abcdef0123456789abcdef012345678",
      "23456789abcdef0123456789abcdef0123456789",
      "3456789abcdef0123456789abcdef0123456789a",
      "456789abcdef0123456789abcdef0123456789ab",
      "56789abcdef0123456789abcdef0123456789abc",
      "6789abcdef0123456789abcdef0123456789abcd",
      "789abcdef0123456789abcdef0123456789abcde",
      "89abcdef0123456789abcdef0123456789abcdef",
      "9abcdef0123456789abcdef0123456789abcdef0"
    ];
    const allShas = [...shortShas, ...fullShas]; // 20 SHAs

    // 30 distinct file paths (mix of POSIX, Windows, relative, and space-separated paths on single lines)
    const filePaths = [
      // Space-separated paths on single line
      "src/models/user.ts", "src/models/account.ts", "src/models/session.ts",
      // Windows paths
      "C:\\Users\\admin\\repo\\index.ts", "D:\\workspace\\project\\config.json",
      "C:/Users/zackm/Desktop/app.tsx", "C:\\AI\\models\\weights.bin",
      // Long extensions (.webmanifest, .dockerfile, .properties)
      "public/site.webmanifest", "deploy/service.dockerfile", "config/app.properties",
      // POSIX paths
      "web-ui/lib/contextBudget.ts", "web-ui/lib/chatUtils.ts", "web-ui/lib/conversationCompaction.ts",
      "web-ui/tests/chatContextBudget.test.ts", "web-ui/tests/llmProvider.test.ts",
      "web-ui/tests/conversationCompaction.test.ts", "mcp-server/src/server.ts",
      "mcp-server/src/tools.ts", "browser-mcp/src/browser.ts", "browser-mcp/src/index.ts",
      "scripts/test-gate.js", "scripts/lan-bridge.js", "scripts/deploy-cluster.js",
      "deploy/k8s/web-ui.yaml", "deploy/k8s/mcp-server.yaml", "deploy/k8s/browser-mcp.yaml",
      "web-ui/app/api/chat/route.ts", "web-ui/app/api/files/route.ts",
      "web-ui/components/ChatStream.tsx", "web-ui/components/WorkspaceViewer.tsx"
    ]; // 30 paths

    // Seed across older messages
    const messages = [
      {
        role: "user",
        content: `Inspect commits ${shortShas.slice(0, 5).join(" ")} and inspect space-separated files: ${filePaths[0]} ${filePaths[1]} ${filePaths[2]}`
      },
      {
        role: "assistant",
        content: `Checking files ${filePaths.slice(3, 10).join(" ")} for commits ${shortShas.slice(5).join(" ")}`,
        tool_calls: [
          {
            function: {
              name: "workspace_read_file",
              arguments: JSON.stringify({ path: filePaths[10] })
            }
          }
        ]
      },
      {
        role: "tool",
        name: "workspace_read_file",
        content: `Read ${filePaths[11]} and ${filePaths[12]} successfully with SHAs ${fullShas.slice(0, 5).join(" ")}`
      },
      {
        role: "user",
        content: `Now check Windows paths: ${filePaths.slice(13, 20).join(" ")} on https://internal.git/repo`
      },
      {
        role: "assistant",
        content: `Error on ${filePaths.slice(20).join(" ")}: fatal compilation error in module with SHAs ${fullShas.slice(5).join(" ")}`
      }
    ];

    const summary = summarizeTurnHistory(messages);

    // Verify all 20 SHAs survive verbatim in summary
    for (const sha of allShas) {
      assert.ok(summary.includes(sha), `Expected git SHA ${sha} to survive verbatim in compaction summary`);
    }

    // Verify all 30 file paths survive verbatim in summary
    for (const fp of filePaths) {
      assert.ok(summary.includes(fp), `Expected file path ${fp} to survive verbatim in compaction summary`);
    }
  });
});

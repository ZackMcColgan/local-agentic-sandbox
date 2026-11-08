import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import { formatHumanReadableTrace } from "../lib/chatUtils";
import { ChatStream } from "../components/ChatStream";

describe("FIX A — Tool-Card Tier Badge Honesty Suite", () => {
  it("formatHumanReadableTrace assigns badge 'host' when tool is host_* or tier is 'host'", () => {
    // 1. host_list_dir
    const trace1 = { tool: "host_list_dir", args: { path: "C:\\AI\\ai-control\\bin" } };
    const h1 = formatHumanReadableTrace(trace1);
    assert.equal(h1.badge, "host", "host_list_dir must have badge 'host'");
    assert.equal(h1.title, "Host List Dir");

    // 2. host_read_file
    const traceRead = { tool: "host_read_file", args: { path: "C:\\AI\\test.txt" } };
    const hRead = formatHumanReadableTrace(traceRead);
    assert.equal(hRead.badge, "host");
    assert.equal(hRead.title, "Host Read test.txt");

    // 3. host_write_file
    const traceWrite = { tool: "host_write_file", args: { path: "C:\\AI\\output.txt", content: "hello" } };
    const hWrite = formatHumanReadableTrace(traceWrite);
    assert.equal(hWrite.badge, "host");
    assert.equal(hWrite.title, "Host Wrote output.txt");

    // 4. host_run_powershell
    const tracePs = { tool: "host_run_powershell", args: { command: "Get-Process -Name node" } };
    const hPs = formatHumanReadableTrace(tracePs);
    assert.equal(hPs.badge, "host");
    assert.ok(hPs.title.startsWith("Ran host PowerShell"));

    // 5. host_delete_path
    const traceDel = { tool: "host_delete_path", args: { path: "C:\\AI\\tmp" } };
    const hDel = formatHumanReadableTrace(traceDel);
    assert.equal(hDel.badge, "host");
    assert.equal(hDel.title, "Host Delete Path");

    // 6. Generic/custom tool with explicit tier: 'host'
    const traceTier = { tool: "custom_diagnostic", args: {}, tier: "host" };
    const hTier = formatHumanReadableTrace(traceTier);
    assert.equal(hTier.badge, "host");
    assert.equal(hTier.title, "Custom Diagnostic");
  });

  it("formatHumanReadableTrace assigns badge 'workspace' for workspace tools or tier 'workspace'", () => {
    const trace1 = { tool: "workspace_read_file", args: { path: "src/app.ts" } };
    const h1 = formatHumanReadableTrace(trace1);
    assert.equal(h1.badge, "workspace");
    assert.equal(h1.title, "Read app.ts");

    const trace2 = { tool: "workspace_write_file", args: { path: "src/config.json" } };
    const h2 = formatHumanReadableTrace(trace2);
    assert.equal(h2.badge, "workspace");
    assert.equal(h2.title, "Wrote config.json");

    const trace3 = { tool: "workspace_run_command", args: { command: "npm test" } };
    const h3 = formatHumanReadableTrace(trace3);
    assert.equal(h3.badge, "workspace");
    assert.ok(h3.title.startsWith("Executed command"));

    const trace4 = { tool: "git_commit" };
    const h4 = formatHumanReadableTrace(trace4);
    assert.equal(h4.badge, "workspace");

    const trace5 = { tool: "arbitrary_tool", tier: "workspace" };
    const h5 = formatHumanReadableTrace(trace5);
    assert.equal(h5.badge, "workspace");
  });

  it("formatHumanReadableTrace preserves existing 'browser' and 'sandbox' badges", () => {
    const traceWeb = { tool: "search_web", args: { query: "local llm benchmarks" } };
    const hWeb = formatHumanReadableTrace(traceWeb);
    assert.equal(hWeb.badge, "browser");
    assert.ok(hWeb.title.includes("Searched the web"));

    const traceFetch = { tool: "fetch_web_page", args: { url: "https://example.com" } };
    const hFetch = formatHumanReadableTrace(traceFetch);
    assert.equal(hFetch.badge, "browser");
    assert.equal(hFetch.title, "Fetched web page");

    const tracePy = { tool: "execute_sandboxed_python", args: { code: "print('hello')" } };
    const hPy = formatHumanReadableTrace(tracePy);
    assert.equal(hPy.badge, "sandbox");
    assert.equal(hPy.title, "Ran Python script");

    const traceUnknown = { tool: "unregistered_tool" };
    const hUnknown = formatHumanReadableTrace(traceUnknown);
    assert.equal(hUnknown.badge, "sandbox");
  });

  it("ChatStream renders distinct badges ('Host', 'Workspace', 'Web', 'Sandbox') per tool trace", () => {
    const messages: any[] = [
      {
        id: "msg-mixed-traces-1",
        role: "assistant",
        content: "Host and workspace traces.",
        traces: [
          {
            tool: "host_list_dir",
            args: { path: "C:\\AI\\ai-control\\bin" },
            tier: "host",
            durationMs: 11
          },
          {
            tool: "workspace_read_file",
            args: { path: "README.md" },
            tier: "workspace",
            durationMs: 25
          }
        ]
      },
      {
        id: "msg-mixed-traces-2",
        role: "assistant",
        content: "Browser and sandbox traces.",
        traces: [
          {
            tool: "search_web",
            args: { query: "node sea" },
            tier: "browser",
            durationMs: 340
          },
          {
            tool: "execute_sandboxed_python",
            args: { code: "print(1)" },
            tier: "sandbox",
            durationMs: 100
          }
        ]
      }
    ];

    const html = renderToString(
      React.createElement(ChatStream, {
        onTracesUpdate: () => {},
        activeModel: "qwen3.8:27b-q3_k_m",
        reasoningEffort: "medium",
        messages
      })
    );

    // Host badge & title
    assert.ok(html.includes("<span>Host</span>"), "ChatStream must render Host badge");
    assert.ok(html.includes("Host List Dir"), "ChatStream must render Host List Dir title");

    // Workspace badge & title
    assert.ok(html.includes("<span>Workspace</span>"), "ChatStream must render Workspace badge");
    assert.ok(html.includes("Read README.md"), "ChatStream must render Read README.md title");

    // Web badge
    assert.ok(html.includes("<span>Web</span>"), "ChatStream must render Web badge");

    // Sandbox badge
    assert.ok(html.includes("<span>Sandbox</span>"), "ChatStream must render Sandbox badge");
  });
});

describe("FIX B — Assistant Response Copy Button Suite", () => {
  it("ChatStream renders a copy response button on every assistant message with content", () => {
    const messages: any[] = [
      {
        id: "msg-asst-1",
        role: "assistant",
        content: "# Heading\n\n- Item 1\n- Item 2\n\n```ts\nconst x = 42;\n```"
      },
      {
        id: "msg-user-1",
        role: "user",
        content: "Please list the items."
      }
    ];

    const html = renderToString(
      React.createElement(ChatStream, {
        onTracesUpdate: () => {},
        activeModel: "qwen3.8:27b-q3_k_m",
        reasoningEffort: "medium",
        messages
      })
    );

    // Assistant message must have copy button
    assert.ok(html.includes('data-testid="copy-response-btn"'), "Must render data-testid='copy-response-btn'");
    assert.ok(html.includes("Copy"), "Must render Copy button label or title");

    // User message must NOT have copy button
    const userMessageCount = (html.match(/data-testid="copy-response-btn"/g) || []).length;
    assert.equal(userMessageCount, 1, "Only the 1 assistant message should have the copy response button");

    // Source verification: Ensure button is NOT hover-only (no opacity-0 group-hover)
    const src = fs.readFileSync(path.resolve(__dirname, "../components/ChatStream.tsx"), "utf8");
    assert.ok(
      !src.includes('data-testid="copy-response-btn" className="opacity-0 group-hover'),
      "Copy response button must be tappable on phone layout without hover"
    );
    assert.ok(src.includes("copyToClipboard(m.content, m.id)"), "Copy button must pass full raw markdown content");
  });

  it("handles streaming assistant messages copying existing content at tap time", () => {
    const partialStreamingMessage = [
      {
        id: "msg-streaming-1",
        role: "assistant",
        content: "This is a partially streamed message..."
      }
    ];

    const html = renderToString(
      React.createElement(ChatStream, {
        onTracesUpdate: () => {},
        activeModel: "qwen3.8:27b-q3_k_m",
        reasoningEffort: "medium",
        isLoading: true,
        messages: partialStreamingMessage
      })
    );

    assert.ok(html.includes('data-testid="copy-response-btn"'), "Streaming message must have copy button available");
    assert.ok(html.includes("This is a partially streamed message..."), "Content must be present at tap time");
  });
});

describe("Part 3 — User Message Copy Button Suite", () => {
  it("ChatStream renders a copy button on every user message", () => {
    const messages: any[] = [
      {
        id: "msg-user-1",
        role: "user",
        content: "What is the weather in Spanish Fort?"
      },
      {
        id: "msg-asst-1",
        role: "assistant",
        content: "The weather is sunny."
      }
    ];

    const html = renderToString(
      React.createElement(ChatStream, {
        onTracesUpdate: () => {},
        activeModel: "qwen3.8:27b-q3_k_m",
        reasoningEffort: "medium",
        messages
      })
    );

    // User message must have data-testid="copy-user-message-btn"
    assert.ok(html.includes('data-testid="copy-user-message-btn"'), "Must render data-testid='copy-user-message-btn'");
    assert.ok(html.includes("Copy"), "Must render Copy text/label on user message");

    // Source verification: ensure copy button wires to copyToClipboard(m.content, m.id)
    const src = fs.readFileSync(path.resolve(__dirname, "../components/ChatStream.tsx"), "utf8");
    assert.ok(src.includes('data-testid="copy-user-message-btn"'), "ChatStream must declare copy-user-message-btn");
    assert.ok(
      src.includes("copyToClipboard(m.content, m.id)"),
      "User copy button must pass m.content and m.id to copyToClipboard"
    );
  });
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { DEFAULT_PRIMARY_MODEL, DEFAULT_SUBAGENT_MODEL, AgentMode } from "@/config/models";

const OLLAMA_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const MCP_URL = process.env.MCP_SERVER_URL || "http://127.0.0.1:8080/sse";

export interface AutonomousStep {
  iteration: number;
  action: string;
  tool?: string;
  args?: Record<string, any>;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  durationMs: number;
  timestamp: string;
}

export interface AutonomousExecutionResult {
  success: boolean;
  iterations: number;
  branch: string;
  summary: string;
  diff: string;
  steps: AutonomousStep[];
  skillsLearned: string[];
}

export class AutonomousEngine {
  private ollamaUrl: string;
  private mcpUrl: string;
  private maxIterations: number;

  constructor(
    ollamaUrl: string = OLLAMA_URL,
    mcpUrl: string = MCP_URL,
    maxIterations: number = 8
  ) {
    this.ollamaUrl = ollamaUrl;
    this.mcpUrl = mcpUrl;
    this.maxIterations = maxIterations;
  }

  private async connectMcp(): Promise<{ client: Client; tools: any[]; close: () => Promise<void> }> {
    const transport = new SSEClientTransport(new URL(this.mcpUrl));
    const client = new Client(
      { name: "autonomous-engine-client", version: "2.0.0" },
      { capabilities: {} }
    );
    await client.connect(transport);
    const toolsRes = await client.listTools();
    return {
      client,
      tools: toolsRes.tools,
      close: async () => {
        try {
          await client.close();
        } catch {}
      }
    };
  }

  public async executeAutonomousLoop(
    objective: string,
    mode: AgentMode = "auto",
    requestedModel?: string,
    onStep?: (step: AutonomousStep) => void
  ): Promise<AutonomousExecutionResult> {
    const mcpSession = await this.connectMcp();
    const steps: AutonomousStep[] = [];
    const skillsLearned: string[] = [];

    let currentModel = requestedModel || (mode === "flash" ? DEFAULT_SUBAGENT_MODEL : DEFAULT_PRIMARY_MODEL);
    let consecutiveFailures = 0;
    let isTaskComplete = false;
    let finalSummary = "";
    let finalDiff = "";
    let activeBranch = "agent/autonomous-task";

    try {
      // 1. Initial whole-repo workspace tree indexing & Git status
      const treeRes: any = await mcpSession.client.callTool({
        name: "workspace_get_tree",
        arguments: { max_depth: 3 }
      });
      const initialTree = treeRes.content?.[0]?.text || "Workspace tree empty";

      const gitStatusRes: any = await mcpSession.client.callTool({
        name: "git_status",
        arguments: { cached: false }
      });
      const gitStatusData = JSON.parse(gitStatusRes.content?.[0]?.text || "{}");
      activeBranch = gitStatusData.branch || "main";

      // 2. Discover learned skills from /workspace/.agent/skills/ (Hermes pattern)
      let skillsContext = "";
      try {
        const skillsTreeRes: any = await mcpSession.client.callTool({
          name: "workspace_get_tree",
          arguments: { sub_path: ".agent/skills", max_depth: 2 }
        });
        if (skillsTreeRes.content?.[0]?.text?.includes(".md")) {
          skillsContext = `\n\n[REUSABLE AGENT SKILLS DISCOVERED]: Check .agent/skills/ for previous proven solutions.`;
        }
      } catch {}

      // Format MCP tools for Ollama
      const ollamaTools = mcpSession.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description || "",
          parameters: t.inputSchema || {}
        }
      }));

      const systemPrompt = `You are an Autonomous Staff Software Engineer ("Private Claude Code") operating inside an isolated, persistent /workspace.
You have full authority to inspect repository files, create feature branches, write code, run test suites, inspect failures, and self-correct until all tests pass with exit_code == 0.

CURRENT REPO STRUCTURE:
${initialTree}
${skillsContext}

OPERATING RULES:
1. When assigned an objective, first inspect relevant files using 'workspace_read_file' or 'workspace_grep'.
2. Create or verify your feature branch using 'git_checkout_branch'.
3. Write clean, robust implementations using 'workspace_write_file'.
4. Immediately execute tests via 'workspace_run_command' (e.g. pytest tests/, npm test).
5. If tests fail (exit_code != 0), analyze the traceback / stderr, modify the code, and re-test.
6. When all tests pass (exit_code == 0), commit with 'git_commit' and output your victory summary.
7. If you solved a novel problem across multiple iterations, record your solution into '.agent/skills/<skill-name>.md'.`;

      const conversationMessages: any[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: `OBJECTIVE: ${objective}\n\nPlease proceed autonomously to inspect, implement, test, and verify.` }
      ];

      let iteration = 0;

      while (iteration < this.maxIterations && !isTaskComplete) {
        iteration++;
        const iterStartTime = performance.now();

        // Query model
        const res = await fetch(`${this.ollamaUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: currentModel,
            messages: conversationMessages,
            tools: ollamaTools,
            stream: false,
            options: {
              temperature: 0.2,
              num_ctx: currentModel.includes("gemma4") ? 16384 : 8192
            }
          })
        });

        if (!res.ok) {
          throw new Error(`Ollama iteration failure: ${await res.text()}`);
        }

        const data = await res.json();
        const msg = data.message;
        const toolCalls = msg.tool_calls || [];

        // If no tool calls, check if objective is fulfilled or output message
        if (toolCalls.length === 0) {
          finalSummary = msg.content || "Autonomous execution complete.";
          if (finalSummary.toLowerCase().includes("passed") || finalSummary.toLowerCase().includes("complete")) {
            isTaskComplete = true;
          }
          break;
        }

        conversationMessages.push(msg);

        // Execute tool calls
        for (const toolCall of toolCalls) {
          const toolName = toolCall.function.name;
          const toolArgs = typeof toolCall.function.arguments === "string"
            ? JSON.parse(toolCall.function.arguments)
            : toolCall.function.arguments;

          const toolStartTime = performance.now();
          const toolRes: any = await mcpSession.client.callTool({
            name: toolName,
            arguments: toolArgs
          });
          const toolDuration = Math.round(performance.now() - toolStartTime);

          let parsedResult: any = {};
          try {
            parsedResult = JSON.parse(toolRes.content?.[0]?.text || "{}");
          } catch {
            parsedResult = { raw: toolRes.content?.[0]?.text };
          }

          const step: AutonomousStep = {
            iteration,
            action: `Tool: ${toolName}`,
            tool: toolName,
            args: toolArgs,
            stdout: parsedResult.stdout,
            stderr: parsedResult.stderr,
            exit_code: parsedResult.exit_code,
            durationMs: toolDuration,
            timestamp: new Date().toISOString()
          };
          steps.push(step);
          if (onStep) onStep(step);

          conversationMessages.push({
            role: "tool",
            name: toolName,
            content: JSON.stringify(parsedResult)
          });

          // Check if test command was executed
          if (toolName === "workspace_run_command") {
            if (parsedResult.exit_code === 0) {
              consecutiveFailures = 0;
              // Check if all tests passed
              if (parsedResult.stdout?.includes("passed") || parsedResult.command?.includes("test")) {
                isTaskComplete = true;
              }
            } else {
              consecutiveFailures++;
              // Auto-escalation to Pro reasoning model on 2 consecutive test failures
              if (mode === "auto" && currentModel.includes("gemma4") && consecutiveFailures >= 2) {
                console.log("[AutonomousEngine] Escalating from Flash to Pro for root-cause diagnosis.");
                currentModel = DEFAULT_PRIMARY_MODEL;
                conversationMessages.push({
                  role: "system",
                  content: "[AUTO-ESCALATION]: Tests failed twice consecutively. Switched to Pro reasoning engine for deep analysis."
                });
              }
            }
          }

          // Track branch changes
          if (toolName === "git_checkout_branch" && parsedResult.current_branch) {
            activeBranch = parsedResult.current_branch;
          }
        }
      }

      // 3. Obtain final git diff and status
      const diffRes: any = await mcpSession.client.callTool({
        name: "git_status",
        arguments: { cached: false }
      });
      const diffData = JSON.parse(diffRes.content?.[0]?.text || "{}");
      finalDiff = diffData.diff || "";
      activeBranch = diffData.branch || activeBranch;

      // 4. Hermes Self-Improving Skill Loop: If multi-turn fixes succeeded, save skill
      if (isTaskComplete && steps.some(s => s.exit_code !== undefined && s.exit_code !== 0)) {
        try {
          const skillSlug = objective.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
          const skillContent = `# Agent Skill: ${objective}
**Learned**: ${new Date().toISOString()}  
**Branch**: \`${activeBranch}\`  
**Root Cause & Solution**:
- Successfully self-corrected across ${iteration} iterations.
- Key adjustments committed in \`${activeBranch}\`.
`;
          await mcpSession.client.callTool({
            name: "workspace_write_file",
            arguments: {
              path: `.agent/skills/${skillSlug}.md`,
              content: skillContent,
              create_dirs: true
            }
          });
          skillsLearned.push(skillSlug);
        } catch {}
      }

      return {
        success: isTaskComplete,
        iterations: iteration,
        branch: activeBranch,
        summary: finalSummary || `Autonomous iteration completed in ${iteration} cycles.`,
        diff: finalDiff,
        steps,
        skillsLearned
      };
    } finally {
      await mcpSession.close();
    }
  }
}

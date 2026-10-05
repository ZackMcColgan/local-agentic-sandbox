import { Milestone, ToolchainType, AcceptanceCriterion } from "./types";
import {
  createOllamaGenerate,
  isFastGraphTestMode,
  stripCodeFence,
  type GenerateFn
} from "./llmClient";

export interface PlanSpecInput {
  taskId: string;
  goal: string;
  toolchain?: ToolchainType;
  model?: string;
  generate?: GenerateFn;
  ollamaUrl?: string;
  keepAlive?: string | number;
}

export interface PlanSpec {
  taskId: string;
  goal: string;
  toolchain: ToolchainType;
  milestones: Milestone[];
  toMarkdown: () => string;
}

/**
 * Generates an overnight execution specification (SPEC.md)
 * defining requirements and verifiable milestones with machine-checkable criteria.
 */
export async function generatePlanSpec(input: PlanSpecInput): Promise<PlanSpec> {
  const taskId = input.taskId || `task-${Date.now()}`;
  const goal = input.goal;
  const toolchain: ToolchainType = input.toolchain || "node:22";

  // Check if we should invoke a real model vs. test-only deterministic decomposition
  const isSynthetic = !input.generate && isFastGraphTestMode();

  let milestones: Milestone[] = [];

  if (!isSynthetic) {
    const generate = input.generate || createOllamaGenerate({ baseUrl: input.ollamaUrl, timeoutMs: 300_000 });
    const modelToUse = input.model || process.env.PLANNER_MODEL || "swift-27b-mtp";

    const prompt = `You are an expert autonomous engineering planner. Decompose the following goal into 3 to 5 verifiable, progressive milestones with machine-checkable acceptance criteria. Be concise.

Goal: ${goal}
Toolchain: ${toolchain}

Respond strictly in valid JSON matching this schema:
{
  "milestones": [
    {
      "id": "M1",
      "title": "Short title",
      "description": "Clear description of deliverables",
      "plannedFiles": ["path/to/file.ts"],
      "acceptanceCriteria": [
        {
          "id": "AC-1-1",
          "assertion": "Verifiable statement of truth",
          "fileMatch": "path/to/file.ts"
        }
      ]
    }
  ]
}`;

    const res = await generate({
      model: modelToUse,
      prompt,
      format: "json",
      keepAlive: input.keepAlive ?? "30m",
      options: { temperature: 0.2, num_predict: 2048 }
    });

    const parsed = JSON.parse(stripCodeFence(res.text));
    if (parsed && Array.isArray(parsed.milestones) && parsed.milestones.length > 0) {
      milestones = parsed.milestones.map((m: any, idx: number) => ({
        id: m.id || `M${idx + 1}`,
        title: m.title || `Milestone ${idx + 1}`,
        description: m.description || "",
        status: "pending",
        builderIterations: 0,
        criticRounds: 0,
        synthetic: false,
        plannedFiles: Array.isArray(m.plannedFiles) ? m.plannedFiles : [],
        acceptanceCriteria: Array.isArray(m.acceptanceCriteria)
          ? m.acceptanceCriteria.map((ac: any, acIdx: number) => ({
              id: ac.id || `AC-${idx + 1}-${acIdx + 1}`,
              assertion: ac.assertion || "Criterion met",
              fileMatch: ac.fileMatch,
              command: ac.command
            }))
          : [{ id: `AC-${idx + 1}-1`, assertion: "Milestone completed successfully" }]
      }));
    }
  }

  if (milestones.length === 0) {
    if (!isFastGraphTestMode()) {
      throw new Error(`Planner model failed to generate plan and FAST_GRAPH_TEST is not enabled for goal: "${goal}"`);
    }
    console.warn(`[Planner] Warning: FAST_GRAPH_TEST mode active. Engaging deterministic fallback plan for goal: "${goal}"`);
    // Deterministic fallback for FAST_GRAPH_TEST mode
    if (goal.toLowerCase().includes("draw.io") || goal.toLowerCase().includes("diagram")) {
    milestones.push({
      id: "M1",
      title: "Inventory Platform Topology & Container Boundaries",
      description: "Inspect docker-compose.yml, deploy/ manifests, and ARCHITECTURE.md to catalog all services, networks, ports, and volumes.",
      status: "pending",
      builderIterations: 0,
      criticRounds: 0,
      synthetic: true,
      plannedFiles: ["deploy/topology-catalog.json"],
      acceptanceCriteria: [
        {
          id: "AC-1-1",
          assertion: "Topology catalog contains mcp-runner, browser-mcp, web-ui, otel-collector, and ollama-service boundaries",
          fileMatch: "deploy/topology-catalog.json"
        },
        {
          id: "AC-1-2",
          assertion: "Network isolation cataloged for ai-mesh (zero egress) and egress-mesh",
          fileMatch: "deploy/topology-catalog.json"
        }
      ]
    });

    milestones.push({
      id: "M2",
      title: "Generate Valid Draw.io XML Architecture Diagram",
      description: "Synthesize complete multi-container system graph with host ROCm passthrough into docs/architecture.drawio.",
      status: "pending",
      builderIterations: 0,
      criticRounds: 0,
      synthetic: true,
      plannedFiles: ["docs/architecture.drawio", "docs/architecture.drawio.svg"],
      acceptanceCriteria: [
        {
          id: "AC-2-1",
          assertion: "File docs/architecture.drawio exists with valid mxfile XML root and background=#ffffff",
          fileMatch: "docs/architecture.drawio",
          command: "node -e \"const fs = require('fs'); const content = fs.readFileSync('docs/architecture.drawio', 'utf8'); if (!content.includes('<mxfile') || !content.includes('background=\\\"#ffffff\\\"')) process.exit(1);\""
        },
        {
          id: "AC-2-2",
          assertion: "Vector diagram docs/architecture.drawio.svg exists and renders valid XML root with clean fill=none connectors",
          fileMatch: "docs/architecture.drawio.svg",
          command: "node -e \"const fs = require('fs'); const content = fs.readFileSync('docs/architecture.drawio.svg', 'utf8'); if (!content.includes('<svg') || content.includes('polygon-error')) process.exit(1);\""
        }
      ]
    });

    milestones.push({
      id: "M3",
      title: "Embed Diagram in Documentation & Verify Zero Discrepancies",
      description: "Verify README.md and ARCHITECTURE.md embed the diagram and match the latest security boundary matrix.",
      status: "pending",
      builderIterations: 0,
      criticRounds: 0,
      synthetic: true,
      plannedFiles: ["docs/topology-matrix.md"],
      acceptanceCriteria: [
        {
          id: "AC-3-1",
          assertion: "Documentation matrix references docs/architecture.drawio.svg",
          fileMatch: "docs/topology-matrix.md",
          command: "node -e \"const fs = require('fs'); const r = fs.readFileSync('docs/topology-matrix.md', 'utf8'); if (!r.includes('architecture.drawio.svg')) process.exit(1);\""
        },
        {
          id: "AC-3-2",
          assertion: "Unit and component test suites exit code 0 across workspaces",
          command: "npm test"
        }
      ]
    });
  } else {
    // General software engineering task decomposition
    milestones.push({
      id: "M1",
      title: "Reconnaissance & Failing Test Fixture",
      description: "Analyze existing source files, define interfaces, and write failing test assertions.",
      status: "pending",
      builderIterations: 0,
      criticRounds: 0,
      synthetic: true,
      acceptanceCriteria: [
        {
          id: "AC-1-1",
          assertion: "Test suite fixture created with explicit expected assertions",
          command: "npm test"
        }
      ]
    });

    milestones.push({
      id: "M2",
      title: "Core Implementation & Self-Correction Loop",
      description: "Implement functionality and iterate until compiler and tests exit code 0.",
      status: "pending",
      builderIterations: 0,
      criticRounds: 0,
      synthetic: true,
      acceptanceCriteria: [
        {
          id: "AC-2-1",
          assertion: "Implementation passes all automated test suites with 0 errors",
          command: "npm test"
        }
      ]
    });

    milestones.push({
      id: "M3",
      title: "Critic Verification, Hygiene & Git Commit",
      description: "Review diff against acceptance criteria, verify zero regressions, and commit cleanly.",
      status: "pending",
      builderIterations: 0,
      criticRounds: 0,
      synthetic: true,
      acceptanceCriteria: [
        {
          id: "AC-3-1",
          assertion: "Git working tree is clean and changes committed with semantic message",
          command: "git status --porcelain"
        }
      ]
    });
  }
}

  const spec: PlanSpec = {
    taskId,
    goal,
    toolchain,
    milestones,
    toMarkdown: () => formatSpecMarkdown(taskId, goal, toolchain, milestones)
  };

  return spec;
}

function formatSpecMarkdown(
  taskId: string,
  goal: string,
  toolchain: ToolchainType,
  milestones: Milestone[]
): string {
  let md = `# SPEC: ${goal}\n\n`;
  md += `**Task ID**: \`${taskId}\`  \n`;
  md += `**Toolchain**: \`${toolchain}\`  \n\n`;
  md += `## Milestones\n\n`;

  for (const m of milestones) {
    md += `### Milestone ${m.id}: ${m.title}\n`;
    md += `${m.description}\n\n`;
    md += `#### Acceptance Criteria:\n`;
    for (const ac of m.acceptanceCriteria) {
      md += `- [${ac.id}] **Assertion**: ${ac.assertion}\n`;
      if (ac.command) md += `  - *Command*: \`${ac.command}\`\n`;
      if (ac.fileMatch) md += `  - *File*: \`${ac.fileMatch}\`\n`;
    }
    md += `\n`;
  }

  return md;
}

/**
 * Parses a SPEC.md document back into machine-checkable milestones.
 */
export function parsePlanSpec(markdown: string): PlanSpec {
  if (!markdown.includes("# SPEC:")) {
    throw new Error("Invalid SPEC.md: missing '# SPEC:' title");
  }

  const goalMatch = markdown.match(/# SPEC:\s*(.+)/);
  const goal = goalMatch ? goalMatch[1].trim() : "Untitled Task";

  const taskIdMatch = markdown.match(/\*\*Task ID\*\*:\s*`([^`]+)`/);
  const taskId = taskIdMatch ? taskIdMatch[1].trim() : `task-${Date.now()}`;

  const toolchainMatch = markdown.match(/\*\*Toolchain\*\*:\s*`([^`]+)`/);
  const toolchain = (toolchainMatch ? toolchainMatch[1].trim() : "node:22") as ToolchainType;

  const milestonesSection = markdown.split(/## Milestones/i)[1];
  if (!milestonesSection) {
    throw new Error("Invalid SPEC.md: missing '## Milestones' section");
  }

  const milestoneChunks = milestonesSection.split(/### Milestone\s+/i).slice(1);
  const milestones: Milestone[] = [];

  for (const chunk of milestoneChunks) {
    const lines = chunk.trim().split("\n");
    const headerLine = lines[0];
    const headerParts = headerLine.split(":");
    const id = headerParts[0].trim();
    const title = headerParts.slice(1).join(":").trim();

    const criteriaIdx = lines.findIndex((l) => l.toLowerCase().includes("acceptance criteria:"));
    if (criteriaIdx === -1) {
      throw new Error(`Milestone ${id} must declare explicit machine-checkable acceptance criteria`);
    }

    const description = lines.slice(1, criteriaIdx).join("\n").trim();
    const criteriaLines = lines.slice(criteriaIdx + 1);
    const acceptanceCriteria: AcceptanceCriterion[] = [];

    for (const cLine of criteriaLines) {
      if (cLine.trim().startsWith("- [") && cLine.includes("]")) {
        const idMatch = cLine.match(/- \[([^\]]+)\]/);
        const cid = idMatch ? idMatch[1] : `AC-${id}-1`;
        const assertion = cLine.split(/\]\s*(\*\*Assertion\*\*:\s*)?/)[2]?.trim() || cLine;
        acceptanceCriteria.push({
          id: cid,
          assertion: assertion.replace(/^\*\*Assertion\*\*:\s*/, "")
        });
      }
    }

    if (acceptanceCriteria.length === 0) {
      throw new Error(`Milestone ${id} must contain >= 1 machine-checkable acceptance criterion`);
    }

    milestones.push({
      id,
      title,
      description,
      status: "pending",
      builderIterations: 0,
      criticRounds: 0,
      acceptanceCriteria
    });
  }

  if (milestones.length === 0) {
    throw new Error("SPEC.md must contain at least 1 milestone");
  }

  return {
    taskId,
    goal,
    toolchain,
    milestones,
    toMarkdown: () => formatSpecMarkdown(taskId, goal, toolchain, milestones)
  };
}

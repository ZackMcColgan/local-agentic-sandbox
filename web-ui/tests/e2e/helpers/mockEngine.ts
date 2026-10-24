import { Page, Route } from "@playwright/test";

export interface MockOptions {
  modelName?: string;
  engineRunning?: boolean;
  projects?: any[];
  threads?: any[];
}

/**
 * Sets up Playwright route intercepts to stub all backend / LLM APIs hermetically.
 * Ensures tests run fast with zero external dependencies and zero GPU requirements.
 */
export async function setupStubbedEngineRoutes(page: Page, options: MockOptions = {}): Promise<void> {
  const {
    modelName = "swift-15-27b-mtp",
    engineRunning = true,
    projects = [
      {
        project_id: "proj-sample-1",
        name: "Enterprise Core",
        slug: "enterprise-core",
        root_path: "/workspace/projects/enterprise-core",
        base_branch: "develop",
        toolchain: "node:22",
        created_at: new Date().toISOString(),
        tasks_count: 2,
        allowlisted: true,
      },
    ],
    threads = [
      {
        id: "thread-fixture-1",
        title: "Initial System Setup",
        createdAt: new Date(Date.now() - 3600000).toISOString(),
        updatedAt: new Date(Date.now() - 1800000).toISOString(),
        messages: [
          { id: "m1", role: "user", content: "Check cluster status" },
          { id: "m2", role: "assistant", content: "All cluster systems operational." },
        ],
      },
    ],
  } = options;

  // 1. Engine status API
  await page.route("**/api/engine**", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: engineRunning ? "running" : "stopped",
        model: modelName,
        running: engineRunning,
        pid: 99999,
        active: engineRunning,
        endpoint: "http://127.0.0.1:11434",
      }),
    });
  });

  // 2. Sandbox status API
  await page.route("**/api/sandbox-status**", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ready: true,
        clusterReady: true,
        ollamaReady: engineRunning,
        podCount: 5,
        healthy: true,
      }),
    });
  });

  // 3. Threads API
  let currentThreads = [...threads];
  await page.route("**/api/threads**", async (route: Route) => {
    const req = route.request();
    if (req.method() === "POST") {
      let postData: any = {};
      try {
        postData = req.postDataJSON() || {};
      } catch {}
      const newThread = {
        id: `thread-${Date.now()}`,
        title: postData.title || "New session",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: postData.messages || [],
      };
      currentThreads.unshift(newThread);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ success: true, thread: newThread, id: newThread.id }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ threads: currentThreads }),
    });
  });

  // Mock Tasks API to ensure hermetic tests start with zero active running tasks
  await page.route("**/api/tasks**", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ activeTask: null, tasks: [] }),
    });
  });

  // Individual thread API
  await page.route("**/api/threads/*", async (route: Route) => {
    const url = route.request().url();
    const id = url.split("/api/threads/")[1]?.split("?")[0];
    const thread = currentThreads.find((t) => t.id === id);
    if (!thread) {
      await route.fulfill({ status: 200, body: JSON.stringify({ id, title: "Session", messages: [] }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(thread),
    });
  });

  // 4. Projects API
  let currentProjects = [...projects];
  await page.route("**/api/projects", async (route: Route) => {
    const req = route.request();
    if (req.method() === "POST") {
      let data: any = {};
      try {
        data = req.postDataJSON() || {};
      } catch {}
      const newProj = {
        project_id: `proj-${Date.now()}`,
        name: data.name || "Test Project",
        slug: (data.name || "test-project").toLowerCase().replace(/[^a-z0-9]/g, "-"),
        root_path: data.rootPath || `/workspace/projects/${Date.now()}`,
        base_branch: data.baseBranch || "main",
        toolchain: data.toolchain || "node:22",
        created_at: new Date().toISOString(),
        tasks_count: 0,
        allowlisted: true,
      };
      currentProjects.push(newProj);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ success: true, project: newProj }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, projects: currentProjects }),
    });
  });

  // 5. Projects browse API
  await page.route("**/api/projects/browse**", async (route: Route) => {
    const req = route.request();
    if (req.method() === "POST") {
      let data: any = {};
      try {
        data = req.postDataJSON() || {};
      } catch {}
      if (data.action === "init-repo") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            targetPath: data.targetPath,
            defaultBranch: "main",
            toolchain: "node:22",
          }),
        });
        return;
      }
      if (data.action === "greenfield") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            targetPath: `/workspace/projects/${data.name}`,
            defaultBranch: "main",
            toolchain: data.toolchain || "node:22",
          }),
        });
        return;
      }
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        allowedRoot: "/workspace/projects",
        currentPath: "/workspace/projects",
        relPath: ".",
        isAtRoot: true,
        parentPath: null,
        items: [
          {
            name: "fixture-repo",
            path: "/workspace/projects/fixture-repo",
            relPath: "fixture-repo",
            isGitRepo: true,
            defaultBranch: "main",
            toolchain: "node:22",
          },
          {
            name: "non-repo-folder",
            path: "/workspace/projects/non-repo-folder",
            relPath: "non-repo-folder",
            isGitRepo: false,
            defaultBranch: "main",
            toolchain: "node:22",
          },
        ],
      }),
    });
  });

  // 6. Skills API
  await page.route("**/api/skills**", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        skills: [
          {
            name: "git-commit-helper",
            description: "Formats atomic semantic git commits",
            iterations: 3,
            promotedAt: new Date().toISOString(),
          },
        ],
        pendingSkills: [
          {
            name: "sql-optimizer",
            description: "Extracts query plan explanations",
            iterations: 2,
            confidence: 0.88,
          },
        ],
      }),
    });
  });

  // 7. Morning Report API
  await page.route("**/api/morning-report**", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        report: {
          generatedAt: new Date().toISOString(),
          summary: {
            totalTasks: 4,
            passedTasks: 4,
            failedTasks: 0,
            reviewedDiffs: 3,
          },
          tasks: [
            {
              id: "task-morning-1",
              title: "Overnight security static analysis",
              status: "completed",
              completedAt: new Date().toISOString(),
              diffStats: { filesChanged: 2, additions: 42, deletions: 5 },
            },
          ],
        },
      }),
    });
  });

  // 8. Chat stream SSE mock (token events followed by done)
  await page.route("**/api/chat**", async (route: Route) => {
    const sseResponse =
      `data: ${JSON.stringify({ type: "token", content: "Analysis complete. " })}\n\n` +
      `data: ${JSON.stringify({ type: "token", content: "All systems verified operational." })}\n\n` +
      `data: ${JSON.stringify({ type: "done", content: "Analysis complete. All systems verified operational." })}\n\n`;

    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      body: sseResponse,
    });
  });
}

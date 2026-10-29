// End-to-End Shakeout Probe Suite
// Exercises all feature areas against deployed cluster with real backend/engine

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3001";

async function run() {
  const results = [];

  async function probe(name, category, testFn) {
    const start = Date.now();
    try {
      const res = await testFn();
      const duration = Date.now() - start;
      results.push({ name, category, passed: true, duration, ...res });
      console.log(`[PASS] [${category}] ${name} (${duration}ms)`);
    } catch (err) {
      const duration = Date.now() - start;
      results.push({ name, category, passed: false, duration, error: err.message, stack: err.stack });
      console.log(`[FAIL] [${category}] ${name} (${duration}ms): ${err.message}`);
    }
  }

  // 1. Engine Control
  await probe("GET /api/engine status", "Engine", async () => {
    const res = await fetch(`${BASE_URL}/api/engine`);
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    return { data };
  });

  await probe("GET /api/sandbox-status", "Engine", async () => {
    const res = await fetch(`${BASE_URL}/api/sandbox-status`);
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    return { data };
  });

  // 2. Chat API (Streaming & SSE)
  await probe("POST /api/chat streaming completion", "Chat", async () => {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Reply with exactly 'OK-PONG' and nothing else." }],
        mode: "chat",
        stream: true
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    const hasData = text.includes("data:");
    return { hasData, snippet: text.slice(0, 200) };
  });

  // 3. Threads / Sessions
  let createdThreadId = null;
  await probe("POST /api/threads create thread", "Sessions", async () => {
    const res = await fetch(`${BASE_URL}/api/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Shakeout Test Thread" })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    createdThreadId = data.thread?.id;
    return { threadId: createdThreadId };
  });

  await probe("GET /api/threads list threads", "Sessions", async () => {
    const res = await fetch(`${BASE_URL}/api/threads`);
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    return { count: data.threads?.length };
  });

  if (createdThreadId) {
    await probe("GET /api/threads/:id fetch thread", "Sessions", async () => {
      const res = await fetch(`${BASE_URL}/api/threads/${createdThreadId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
      return { id: data.thread?.id };
    });
  }

  // 4. Projects & Folders
  let testProjectId = null;
  await probe("GET /api/projects list projects", "Projects", async () => {
    const res = await fetch(`${BASE_URL}/api/projects`);
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    return { projects: data.projects?.length };
  });

  await probe("POST /api/projects register project", "Projects", async () => {
    const res = await fetch(`${BASE_URL}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "shakeout-fixture",
        path: "/workspace/projects/shakeout-fixture",
        description: "Fixture project for shakeout verification",
        default_branch: "main"
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    testProjectId = data.project?.id;
    return { projectId: testProjectId };
  });

  if (testProjectId) {
    await probe("GET /api/projects/:id details", "Projects", async () => {
      const res = await fetch(`${BASE_URL}/api/projects/${testProjectId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
      return { id: data.project?.id };
    });

    await probe("GET /api/projects/:id/files browse", "Projects", async () => {
      const res = await fetch(`${BASE_URL}/api/projects/${testProjectId}/files`);
      const data = await res.json();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
      return { files: data.tree?.length };
    });

    await probe("GET /api/projects/:id/diff review", "Projects", async () => {
      const res = await fetch(`${BASE_URL}/api/projects/${testProjectId}/diff`);
      const data = await res.json();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
      return { diff: data.diff || "" };
    });
  }

  // 5. Skills
  await probe("GET /api/skills list skills", "Skills", async () => {
    const res = await fetch(`${BASE_URL}/api/skills`);
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    return { skills: data.skills?.length };
  });

  // 6. Morning Report
  await probe("GET /api/morning-report", "MorningReport", async () => {
    const res = await fetch(`${BASE_URL}/api/morning-report`);
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    return { hasReport: Boolean(data.report) };
  });

  // 7. Scheduler & Schedules
  await probe("GET /api/scheduler/health", "Scheduler", async () => {
    const res = await fetch(`${BASE_URL}/api/scheduler/health`);
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    return { status: data.status };
  });

  await probe("GET /api/schedules list", "Scheduler", async () => {
    const res = await fetch(`${BASE_URL}/api/schedules`);
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    return { count: data.schedules?.length };
  });

  // 8. Workspace / Files
  await probe("GET /api/workspace/file read file", "Workspace", async () => {
    const res = await fetch(`${BASE_URL}/api/workspace/file?path=README.md`);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return { length: data.content?.length };
  });

  // 9. Traces
  await probe("GET /api/traces list", "Traces", async () => {
    const res = await fetch(`${BASE_URL}/api/traces`);
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    return { count: data.traces?.length };
  });

  // 10. Build Mode Task Lifecycle (Testing SNIPPET / SCRIPT / PROJECT scopes)
  await probe("POST /api/threads launchTask SCRIPT scope", "BuildMode", async () => {
    const res = await fetch(`${BASE_URL}/api/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "launchTask",
        goal: "Generate a standalone helper math.js that exports add and sub",
        scope: "SCRIPT",
        toolchain: "node:22"
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    return { taskId: data.task?.taskId, status: data.task?.status };
  });

  await probe("POST /api/threads launchTask PROJECT scope", "BuildMode", async () => {
    const res = await fetch(`${BASE_URL}/api/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "launchTask",
        goal: "Implement string utility formatSlug in utils/slug.ts with tests",
        scope: "PROJECT",
        toolchain: "node:22"
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    return { taskId: data.task?.taskId, status: data.task?.status };
  });

  console.log("\n=================== SHAKEOUT SUMMARY ===================");
  console.log(`Total Probes: ${results.length}`);
  console.log(`Passed: ${results.filter(r => r.passed).length}`);
  console.log(`Failed: ${results.filter(r => !r.passed).length}`);
}

run().catch(console.error);

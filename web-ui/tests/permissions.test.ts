import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { ThreadStore } from "../lib/threads/threadStore";

describe("Shared-Volume Permission Hardening Suite (0770/0660)", () => {
  let tempDir: string | null = null;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "perm-test-"));
  });

  afterEach(() => {
    process.env = { ...origEnv };
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("Test 1: Static verification — assert 0o777 or octal 0777 does NOT appear in threadStore.ts or route.ts", () => {
    const threadStorePath = path.resolve(__dirname, "../lib/threads/threadStore.ts");
    const routePath = path.resolve(__dirname, "../app/api/chat/route.ts");

    const threadStoreCode = fs.readFileSync(threadStorePath, "utf8");
    const routeCode = fs.readFileSync(routePath, "utf8");

    // Must not contain 0o777 or octal 0777 in any form
    const octal777Regex = /0o777|(?:\b0777\b)/;

    assert.strictEqual(
      octal777Regex.test(threadStoreCode),
      false,
      "web-ui/lib/threads/threadStore.ts must NOT contain 0o777 or 0777"
    );

    assert.strictEqual(
      octal777Regex.test(routeCode),
      false,
      "web-ui/app/api/chat/route.ts must NOT contain 0o777 or 0777"
    );

    // Verify 0o770 is present instead
    assert.match(threadStoreCode, /0o770/, "web-ui/lib/threads/threadStore.ts must use 0o770");
    assert.match(routeCode, /0o770/, "web-ui/app/api/chat/route.ts must use 0o770");

    // Verify writeFileSync with mode 0o660 is present in threadStore.ts
    assert.match(
      threadStoreCode,
      /0o660/,
      "web-ui/lib/threads/threadStore.ts must use 0o660 for write operations"
    );
  });

  it("Test 2: Runtime directory permissions — verify directories are created with 0770 permissions", () => {
    const targetThreadsDir = path.join(tempDir!, "threads_runtime_dir");

    // Track mkdirSync and chmodSync calls
    const origMkdirSync = fs.mkdirSync;
    const origChmodSync = fs.chmodSync;
    const mkdirCalls: Array<{ path: string; options?: fs.MakeDirectoryOptions | fs.Mode | null }> =
      [];
    const chmodCalls: Array<{ path: string; mode: fs.Mode }> = [];

    try {
      const fsMutable = fs as unknown as {
        mkdirSync: typeof fs.mkdirSync;
        chmodSync: typeof fs.chmodSync;
      };
      fsMutable.mkdirSync = ((p: fs.PathLike, opt?: fs.MakeDirectoryOptions | fs.Mode | null) => {
        mkdirCalls.push({ path: String(p), options: opt });
        return origMkdirSync(p, opt as fs.MakeDirectoryOptions);
      }) as typeof fs.mkdirSync;
      fsMutable.chmodSync = ((p: fs.PathLike, m: fs.Mode) => {
        chmodCalls.push({ path: String(p), mode: m });
        return origChmodSync(p, m);
      }) as typeof fs.chmodSync;

      new ThreadStore(targetThreadsDir);
      assert.ok(fs.existsSync(targetThreadsDir), "threads directory should be created");

      // Verify that any mkdirSync calls specify mode 0o770
      const relevantMkdir = mkdirCalls.find((c) => c.path.includes("threads_runtime_dir"));
      if (relevantMkdir && relevantMkdir.options && typeof relevantMkdir.options === "object") {
        assert.strictEqual(
          relevantMkdir.options.mode,
          0o770,
          "mkdirSync must be called with mode 0o770"
        );
      }

      // Verify that any chmodSync calls pass 0o770 (never 0o777)
      for (const call of chmodCalls) {
        assert.notStrictEqual(call.mode, 0o777, `chmodSync called with 0o777 on ${call.path}`);
      }

      // On POSIX systems, check actual filesystem mode
      if (process.platform !== "win32") {
        const stat = fs.statSync(targetThreadsDir);
        const mode = stat.mode & 0o777;
        assert.strictEqual(
          mode & 0o007,
          0,
          `Directory ${targetThreadsDir} must have zero world permissions (got ${mode.toString(8)})`
        );
      }
    } finally {
      fs.mkdirSync = origMkdirSync;
      fs.chmodSync = origChmodSync;
    }
  });

  it("Test 3: Runtime file permissions — verify saved thread JSON files have 0660 permissions", () => {
    const targetThreadsDir = path.join(tempDir!, "threads_runtime_file");
    fs.mkdirSync(targetThreadsDir, { recursive: true, mode: 0o770 });

    const store = new ThreadStore(targetThreadsDir);
    const thread = store.createThread({
      title: "Test Hardened Thread",
      initialPrompt: "Testing file mode 0660",
    });

    assert.ok(thread && thread.id);
    const filePath = store.getFilePath(thread.id);
    assert.ok(fs.existsSync(filePath), "Thread file should exist");

    // Behavioral check: the saved file on disk carries mode 0660, however the
    // store wrote it (direct write or atomic temp+rename). The contract is the
    // file's permissions, not the write mechanism.
    if (process.platform !== "win32") {
      const stat = fs.statSync(filePath);
      const mode = stat.mode & 0o777;
      assert.strictEqual(
        mode,
        0o660,
        `File ${filePath} must have mode 0660 (got ${mode.toString(8)})`
      );
    }
  });

  it("Test 4: Manifest verification — verify mutual supplementalGroups in deploy/k8s", () => {
    const mcpRunnerPath = path.resolve(__dirname, "../../deploy/k8s/mcp-runner.yaml");
    const webUiPath = path.resolve(__dirname, "../../deploy/k8s/web-ui.yaml");

    assert.ok(fs.existsSync(mcpRunnerPath), "deploy/k8s/mcp-runner.yaml must exist");
    assert.ok(fs.existsSync(webUiPath), "deploy/k8s/web-ui.yaml must exist");

    const mcpRunnerYaml = fs.readFileSync(mcpRunnerPath, "utf8");
    const webUiYaml = fs.readFileSync(webUiPath, "utf8");

    // web-ui has runAsUser: 1001, runAsGroup: 1001, supplementalGroups: [10001]
    assert.match(
      webUiYaml,
      /supplementalGroups:\s*\[10001\]/,
      "web-ui.yaml must define supplementalGroups: [10001]"
    );

    // mcp-runner has runAsUser: 10001, runAsGroup: 10001, supplementalGroups: [1001]
    assert.match(
      mcpRunnerYaml,
      /supplementalGroups:\s*\[1001\]/,
      "mcp-runner.yaml must define supplementalGroups: [1001]"
    );
  });

  it("Test 5: web-ui container memory limit is 2Gi (OOMKill RCA: raised from 1Gi)", () => {
    const webUiPath = path.resolve(__dirname, "../../deploy/k8s/web-ui.yaml");
    const webUiYaml = fs.readFileSync(webUiPath, "utf8");

    // RCA: pod web-ui was OOMKilled under load with limits.memory: 1Gi (Nov 21 2026)
    // after previously being raised from 384Mi (Nov 12 2026). The web-ui container limit must be 2Gi.
    assert.match(
      webUiYaml,
      /limits:\s*\n\s*cpu:\s*"?1000m"?\s*\n\s*memory:\s*"2Gi"/,
      "deploy/k8s/web-ui.yaml must set the web-ui container memory limit to 2Gi"
    );

    // The old 384Mi ceiling must be gone entirely.
    assert.ok(
      !webUiYaml.includes("384Mi"),
      "deploy/k8s/web-ui.yaml must no longer contain the 384Mi memory limit"
    );

    // CPU limits and requests must remain unchanged.
    assert.match(webUiYaml, /cpu:\s*"?1000m"?/, "web-ui CPU limit must stay 1000m");
    assert.match(
      webUiYaml,
      /requests:\s*\n\s*cpu:\s*"?100m"?\s*\n\s*memory:\s*"128Mi"/,
      "web-ui requests must stay cpu 100m / memory 128Mi"
    );
  });

  it("Test 6: LLM_SUPERVISOR_TOKEN in deploy/k8s/web-ui.yaml is sourced from secretKeyRef, never plaintext", () => {
    const webUiPath = path.resolve(__dirname, "../../deploy/k8s/web-ui.yaml");
    const webUiYaml = fs.readFileSync(webUiPath, "utf8");

    const envEntryMatch = webUiYaml.match(
      /-\s+name:\s+LLM_SUPERVISOR_TOKEN\r?\n([\s\S]*?)(?=\r?\n\s*-\s+name:|\r?\n\s*securityContext:)/
    );
    assert.ok(envEntryMatch, "deploy/k8s/web-ui.yaml must declare LLM_SUPERVISOR_TOKEN");
    const envBlock = envEntryMatch[1];

    assert.doesNotMatch(
      envBlock,
      /^\s*value:/m,
      "LLM_SUPERVISOR_TOKEN must not use a plaintext value field"
    );
    assert.match(
      envBlock,
      /valueFrom:\s*\r?\n\s*secretKeyRef:\s*\r?\n\s*name:\s*[a-z0-9-]+/,
      "LLM_SUPERVISOR_TOKEN must reference a Kubernetes Secret via valueFrom.secretKeyRef.name"
    );
    assert.match(
      envBlock,
      /key:\s*[a-z0-9-]+/,
      "LLM_SUPERVISOR_TOKEN secretKeyRef must specify a key"
    );
  });
});

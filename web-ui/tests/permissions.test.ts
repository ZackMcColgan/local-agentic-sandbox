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
    assert.match(
      threadStoreCode,
      /0o770/,
      "web-ui/lib/threads/threadStore.ts must use 0o770"
    );
    assert.match(
      routeCode,
      /0o770/,
      "web-ui/app/api/chat/route.ts must use 0o770"
    );

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
    const mkdirCalls: Array<{ path: string; options?: any }> = [];
    const chmodCalls: Array<{ path: string; mode: any }> = [];

    try {
      (fs as any).mkdirSync = (p: any, opt?: any) => {
        mkdirCalls.push({ path: String(p), options: opt });
        return origMkdirSync(p, opt);
      };
      (fs as any).chmodSync = (p: any, m: any) => {
        chmodCalls.push({ path: String(p), mode: m });
        return origChmodSync(p, m);
      };

      const store = new ThreadStore(targetThreadsDir);
      assert.ok(fs.existsSync(targetThreadsDir), "threads directory should be created");

      // Verify that any mkdirSync calls specify mode 0o770
      const relevantMkdir = mkdirCalls.find((c) => c.path.includes("threads_runtime_dir"));
      if (relevantMkdir && relevantMkdir.options) {
        assert.strictEqual(
          relevantMkdir.options.mode,
          0o770,
          "mkdirSync must be called with mode 0o770"
        );
      }

      // Verify that any chmodSync calls pass 0o770 (never 0o777)
      for (const call of chmodCalls) {
        assert.notStrictEqual(
          call.mode,
          0o777,
          `chmodSync called with 0o777 on ${call.path}`
        );
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

    const origWriteFileSync = fs.writeFileSync;
    const writeCalls: Array<{ path: string; options?: any }> = [];

    try {
      (fs as any).writeFileSync = (p: any, data: any, opt?: any) => {
        writeCalls.push({ path: String(p), options: opt });
        return origWriteFileSync(p, data, opt);
      };

      const store = new ThreadStore(targetThreadsDir);
      const thread = store.createThread({
        title: "Test Hardened Thread",
        initialPrompt: "Testing file mode 0660"
      });

      assert.ok(thread && thread.id);
      const filePath = store.getFilePath(thread.id);
      assert.ok(fs.existsSync(filePath), "Thread file should exist");

      // Verify writeFileSync calls used mode 0o660
      const threadWrites = writeCalls.filter((c) => c.path.includes(thread.id));
      assert.ok(threadWrites.length > 0, "Expected writeFileSync calls for thread");
      for (const call of threadWrites) {
        assert.ok(
          call.options && typeof call.options === "object",
          `writeFileSync options should be an object (got ${typeof call.options})`
        );
        assert.strictEqual(
          call.options.mode,
          0o660,
          `writeFileSync must be called with mode 0o660 on ${call.path}`
        );
      }

      // On POSIX systems, check actual filesystem mode
      if (process.platform !== "win32") {
        const stat = fs.statSync(filePath);
        const mode = stat.mode & 0o777;
        assert.strictEqual(
          mode & 0o007,
          0,
          `File ${filePath} must have zero world permissions (got ${mode.toString(8)})`
        );
      }
    } finally {
      fs.writeFileSync = origWriteFileSync;
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

  it("Test 5: web-ui container memory limit is 1Gi (OOMKill RCA: 384Mi ceiling)", () => {
    const webUiPath = path.resolve(__dirname, "../../deploy/k8s/web-ui.yaml");
    const webUiYaml = fs.readFileSync(webUiPath, "utf8");

    // RCA: pod web-ui-548b99549f-665xt was OOMKilled at 01:01 CT Nov 12 2026
    // under load with limits.memory: 384Mi. The web-ui container limit must be 1Gi.
    assert.match(
      webUiYaml,
      /limits:\s*\n\s*cpu:\s*"?1000m"?\s*\n\s*memory:\s*"1Gi"/,
      "deploy/k8s/web-ui.yaml must set the web-ui container memory limit to 1Gi"
    );

    // The old 384Mi ceiling must be gone entirely.
    assert.ok(
      !webUiYaml.includes("384Mi"),
      "deploy/k8s/web-ui.yaml must no longer contain the 384Mi memory limit"
    );

    // CPU limits and requests must remain unchanged.
    assert.match(webUiYaml, /cpu:\s*"?1000m"?/, "web-ui CPU limit must stay 1000m");
    assert.match(webUiYaml, /requests:\s*\n\s*cpu:\s*"?100m"?\s*\n\s*memory:\s*"128Mi"/,
      "web-ui requests must stay cpu 100m / memory 128Mi");
  });
});

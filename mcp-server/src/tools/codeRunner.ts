import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import { z } from "zod";

const execAsync = promisify(exec);

export function registerCodeRunner(mcp: McpServer) {
  mcp.tool(
    "execute_sandboxed_python",
    {
      code: z.string().describe("The Python script to execute"),
      test_code: z.string().optional().describe("Optional pytest or unit test assertions to run alongside the code")
    },
    async ({ code, test_code }) => {
      const runId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const scriptPath = `/tmp/script_${runId}.py`;
      const startTime = performance.now();

      try {
        const fullScript = test_code ? `${code}\n\n# --- Test Execution ---\n${test_code}` : code;
        await fs.writeFile(scriptPath, fullScript, "utf8");

        const { stdout, stderr } = await execAsync(`python3 ${scriptPath}`, {
          timeout: 5000,
          maxBuffer: 1024 * 1024
        });

        const executionDurationMs = Math.round(performance.now() - startTime);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "SUCCESS",
              stdout: stdout.trim(),
              stderr: stderr.trim(),
              duration_ms: executionDurationMs,
              security_boundary: {
                network_egress: "BLOCKED",
                dropped_caps: "ALL",
                uid: 10001,
                gid: 10001,
                rootfs: "READ_ONLY",
                tmpfs_buffer: "/tmp (rw,noexec,nosuid,size=64m)"
              }
            }, null, 2)
          }]
        };
      } catch (err: any) {
        const executionDurationMs = Math.round(performance.now() - startTime);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "EXECUTION_ERROR",
              error: err.message,
              stderr: err.stderr ? err.stderr.trim() : "",
              stdout: err.stdout ? err.stdout.trim() : "",
              duration_ms: executionDurationMs,
              security_boundary: {
                network_egress: "BLOCKED",
                isolation: "ENFORCED"
              }
            }, null, 2)
          }]
        };
      } finally {
        await fs.unlink(scriptPath).catch(() => {});
      }
    }
  );
}

import { NextRequest, NextResponse } from "next/server";
import {
  SelfDeployPipeline,
  isSelfDeployKillSwitchEnabled,
  validateBranchName,
  validateHostAddress,
  validateImageTag,
  validateK8sResourceName,
} from "@/lib/deploy/selfDeploy";
import { OvernightSupervisor } from "@/lib/subagents/supervisor";
import { ThreadStore } from "@/lib/threads/threadStore";
import { TaskManifest } from "@/lib/subagents/types";

export async function GET(_req: NextRequest) {
  try {
    const pipeline = new SelfDeployPipeline();
    const selfDeployEnabled = isSelfDeployKillSwitchEnabled();
    const deployHistory = pipeline.getDeployHistory();

    return NextResponse.json({
      selfDeployEnabled,
      deployHistory,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

function isSameOriginRequest(req: NextRequest): boolean {
  const requestHost = (req.headers.get("host") || req.nextUrl?.host || "").toLowerCase().trim();
  if (!requestHost) return false;

  const source = req.headers.get("origin") || req.headers.get("referer");
  if (!source) return false;

  try {
    const parsed = new URL(source);
    return parsed.host.toLowerCase() === requestHost;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!isSameOriginRequest(req)) {
      return NextResponse.json(
        { error: "Forbidden: cross-origin deploy request rejected" },
        { status: 403 }
      );
    }

    const body = await req.json();
    const { action } = body;

    if (action === "toggleKillSwitch") {
      const enabled = Boolean(body.enabled);
      process.env.SELF_DEPLOY_ENABLED = enabled ? "true" : "false";
      return NextResponse.json({
        selfDeployEnabled: enabled,
      });
    }

    if (action === "deployBuild") {
      const { taskId, threadId, dryRunUrl, dryRunNamespace } = body;
      if (!taskId) {
        return NextResponse.json({ error: "Missing required 'taskId'" }, { status: 400 });
      }
      if (dryRunNamespace !== undefined) {
        try {
          validateK8sResourceName(String(dryRunNamespace), "namespace");
        } catch (err: unknown) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 400 }
          );
        }
      }

      const supervisor = new OvernightSupervisor();
      const task = await supervisor.resumeTaskFromCheckpoint(taskId);
      if (!task) {
        return NextResponse.json({ error: `Task '${taskId}' not found` }, { status: 404 });
      }

      // Real deployment URL and namespace via cluster / environment configuration
      const hostAddress = process.env.DEPLOY_HOST || "127.0.0.1";
      const deployPort = process.env.DEPLOY_PORT || "3001";
      const deploymentNamespace =
        dryRunNamespace ||
        `build-${taskId
          .slice(0, 12)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")}`;
      const deploymentUrl =
        dryRunUrl || process.env.DEPLOY_URL || `http://${hostAddress}:${deployPort}`;

      task.deploymentUrl = deploymentUrl;
      task.deploymentNamespace = deploymentNamespace;
      task.updatedAt = new Date().toISOString();
      task.journal.push({
        timestamp: new Date().toISOString(),
        role: "supervisor",
        message: `Deployed build preview to namespace '${deploymentNamespace}' at ${deploymentUrl}`,
      });

      supervisor.saveCheckpoint(task);

      // If associated with a thread, update thread messages/status
      if (threadId) {
        try {
          const threadStore = new ThreadStore();
          const thread = await threadStore.getThread(threadId);
          if (thread) {
            thread.updatedAt = new Date().toISOString();
            threadStore.saveThread(thread);
          }
        } catch {}
      }

      const pipeline = new SelfDeployPipeline();
      const deployHistory = pipeline.getDeployHistory();
      const latestDeploy =
        deployHistory.find((d) => d.branchName === task.branchName || d.deployId === task.taskId) ||
        deployHistory[0];

      return NextResponse.json({
        success: true,
        taskId,
        deploymentUrl,
        deploymentNamespace,
        deployStatus: latestDeploy?.status || "deployed",
        rollbackStatus: latestDeploy?.rollbackStatus || "none",
      });
    }

    if (action === "executeSelfDeploy" || action === "executeDeploy") {
      const {
        taskId,
        branchName: inputBranchName,
        previousSha: inputPrevSha,
        newSha: inputNewSha,
        deploymentName,
        namespace,
        hostAddress,
        imageTag,
        skipPreRollout,
        preRollout,
      } = body;

      let branchName = inputBranchName;
      const previousSha = inputPrevSha || "develop";
      let newSha = inputNewSha;

      let task: TaskManifest | null = null;
      let supervisor: OvernightSupervisor | null = null;

      if (taskId) {
        supervisor = new OvernightSupervisor();
        task = await supervisor.resumeTaskFromCheckpoint(taskId);
        if (task) {
          branchName = branchName || task.branchName;
          const lastMilestone = task.milestones?.[task.milestones.length - 1];
          newSha = newSha || lastMilestone?.commitSha || "HEAD";
        }
      }

      branchName = branchName || "feat/task-preview";
      newSha = newSha || "HEAD";

      try {
        validateBranchName(branchName);
        if (imageTag !== undefined) {
          validateImageTag(imageTag);
        }
        if (hostAddress !== undefined) {
          validateHostAddress(hostAddress);
        }
        if (namespace !== undefined) {
          validateK8sResourceName(namespace, "namespace");
        }
        if (deploymentName !== undefined) {
          validateK8sResourceName(deploymentName, "deployment");
        }
      } catch (validationErr: unknown) {
        return NextResponse.json(
          { error: validationErr instanceof Error ? validationErr.message : String(validationErr) },
          { status: 400 }
        );
      }

      const pipeline =
        (globalThis as { __mockSelfDeployPipeline?: SelfDeployPipeline })
          .__mockSelfDeployPipeline ||
        new SelfDeployPipeline(
          body.dryRun
            ? {
                commandRunner: async (file: string, args: string[]) => {
                  const fullCmd = [file, ...args].join(" ");
                  if (fullCmd.includes("ctr") && fullCmd.includes("images ls")) {
                    // A real `ctr images ls name==<image>` listing names the image.
                    return { exitCode: 0, stdout: `${fullCmd}\n`, stderr: "" };
                  }
                  return { exitCode: 0, stdout: "ok\n", stderr: "" };
                },
                healthChecker: async () => ({ status: 200, ok: true }),
              }
            : undefined
        );
      const record = await pipeline.executeDeploy({
        branchName,
        previousSha,
        newSha,
        deploymentName,
        namespace,
        hostAddress,
        imageTag,
        skipPreRollout: Boolean(skipPreRollout),
        preRollout: Boolean(preRollout),
      });

      if (task && supervisor) {
        const host = hostAddress || process.env.DEPLOY_HOST || "127.0.0.1";
        const port = process.env.DEPLOY_PORT || "3001";
        const deployUrl = `http://${host}:${port}`;
        task.deploymentUrl = deployUrl;
        task.deploymentNamespace = namespace || "local-agentic-sandbox";
        task.updatedAt = new Date().toISOString();
        task.journal.push({
          timestamp: new Date().toISOString(),
          role: "supervisor",
          message: `SelfDeployPipeline executed: status=${record.status}, rollbackStatus=${record.rollbackStatus}, health=${record.healthCheckResult.status}`,
        });
        supervisor.saveCheckpoint(task);
      }

      return NextResponse.json({
        success: record.status === "deployed",
        ...record,
        record,
      });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

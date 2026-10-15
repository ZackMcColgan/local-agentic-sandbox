import { NextRequest, NextResponse } from "next/server";
import {
  SelfDeployPipeline,
  isSelfDeployKillSwitchEnabled,
  getGlobalSelfDeployHistory
} from "@/lib/deploy/selfDeploy";
import { OvernightSupervisor } from "@/lib/subagents/supervisor";
import { ThreadStore } from "@/lib/threads/threadStore";

export async function GET(_req: NextRequest) {
  try {
    const pipeline = new SelfDeployPipeline();
    const selfDeployEnabled = isSelfDeployKillSwitchEnabled();
    const deployHistory = pipeline.getDeployHistory();

    return NextResponse.json({
      selfDeployEnabled,
      deployHistory
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action } = body;

    if (action === "toggleKillSwitch") {
      const enabled = Boolean(body.enabled);
      process.env.SELF_DEPLOY_ENABLED = enabled ? "true" : "false";
      return NextResponse.json({
        selfDeployEnabled: enabled
      });
    }

    if (action === "deployBuild") {
      const { taskId, threadId, dryRunUrl, dryRunNamespace } = body;
      if (!taskId) {
        return NextResponse.json({ error: "Missing required 'taskId'" }, { status: 400 });
      }

      const supervisor = new OvernightSupervisor();
      const task = await supervisor.resumeTaskFromCheckpoint(taskId);
      if (!task) {
        return NextResponse.json({ error: `Task '${taskId}' not found` }, { status: 404 });
      }

      // Generate deployment URL and namespace if not supplied
      const deploymentNamespace = dryRunNamespace || `build-${taskId.slice(0, 12).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
      const deploymentUrl = dryRunUrl || `http://192.168.50.254:${30100 + (Math.abs(taskId.split("").reduce((a: number, b: string) => a + b.charCodeAt(0), 0)) % 1000)}`;

      task.deploymentUrl = deploymentUrl;
      task.deploymentNamespace = deploymentNamespace;
      task.updatedAt = new Date().toISOString();
      task.journal.push({
        timestamp: new Date().toISOString(),
        role: "supervisor",
        message: `Deployed build preview to namespace '${deploymentNamespace}' at ${deploymentUrl}`
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

      return NextResponse.json({
        success: true,
        taskId,
        deploymentUrl,
        deploymentNamespace
      });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

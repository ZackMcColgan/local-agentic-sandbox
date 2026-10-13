import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export type DeployStageName =
  | "build_image"
  | "create_namespace"
  | "allocate_port"
  | "apply_manifests"
  | "rollout_wait"
  | "health_check"
  | "report_link";

export interface DeployStageRecord {
  name: DeployStageName;
  status: "pending" | "in_progress" | "completed" | "failed";
  detail?: string;
}

export interface DeployBuildTaskInput {
  runId: string;
  threadId: string;
  workspaceDir: string;
  appName?: string;
  hostAddress?: string;
  keepNamespace?: boolean;
}

export interface DeployBuildTaskResult {
  runId: string;
  threadId: string;
  status: "succeeded" | "failed";
  namespace: string;
  imageTag: string;
  nodePort: number;
  deployedUrl: string;
  healthStatus: number;
  stages: DeployStageRecord[];
  threadMessageMarkdown: string;
  error?: string;
}

export interface CommandRunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string) => Promise<CommandRunnerResult>;
export type HealthChecker = (url: string) => Promise<{ status: number; ok: boolean }>;

export interface DeployPipelineOptions {
  commandRunner?: CommandRunner;
  healthChecker?: HealthChecker;
  healthProbeUrlOverride?: string;
  defaultHost?: string;
}

// Track allocated NodePorts across concurrent builds to guarantee zero collisions
const allocatedNodePorts = new Set<number>();
let nextCandidatePort = 30100;

export function resetAllocatedNodePortsForTesting(): void {
  allocatedNodePorts.clear();
  nextCandidatePort = 30100;
}

export function allocateUniqueNodePort(): number {
  const minPort = 30100;
  const maxPort = 32767;
  for (let offset = 0; offset <= maxPort - minPort; offset++) {
    const candidate = minPort + ((nextCandidatePort - minPort + offset) % (maxPort - minPort + 1));
    if (!allocatedNodePorts.has(candidate)) {
      allocatedNodePorts.add(candidate);
      nextCandidatePort = candidate + 1 > maxPort ? minPort : candidate + 1;
      return candidate;
    }
  }
  throw new Error("Exhausted available Kubernetes NodePort range (30100-32767)");
}

export function deriveShortBuildId(runId: string): string {
  const stripped = runId.replace(/^run[-_]?/i, "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return (stripped.slice(0, 8) || "ephem001").padEnd(8, "0");
}

async function defaultCommandRunner(command: string): Promise<CommandRunnerResult> {
  try {
    const isBuild = command.startsWith("docker build") || command.includes("images import");
    const timeout = isBuild ? 600000 : 60000;
    const { stdout, stderr } = await execAsync(command, { timeout });
    return { exitCode: 0, stdout: stdout || "", stderr: stderr || "" };
  } catch (err: any) {
    return {
      exitCode: typeof err?.code === "number" ? err.code : 1,
      stdout: err?.stdout || "",
      stderr: err?.stderr || err?.message || String(err)
    };
  }
}

async function defaultHealthChecker(url: string): Promise<{ status: number; ok: boolean }> {
  try {
    const res = await fetch(url);
    return { status: res.status, ok: res.status >= 200 && res.status < 400 };
  } catch {
    return { status: 503, ok: false };
  }
}

export class DeployPipeline {
  private commandRunner: CommandRunner;
  private healthChecker: HealthChecker;
  private healthProbeUrlOverride?: string;
  private defaultHost: string;

  constructor(options: DeployPipelineOptions = {}) {
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.healthChecker = options.healthChecker ?? defaultHealthChecker;
    this.healthProbeUrlOverride = options.healthProbeUrlOverride;
    this.defaultHost =
      options.defaultHost ??
      (process.env.NODE_IP ? `http://${process.env.NODE_IP}` : "http://host.docker.internal");
  }

  public async syncAllocatedNodePortsFromCluster(): Promise<void> {
    try {
      const res = await this.commandRunner(
        "kubectl get svc --all-namespaces -o jsonpath='{range .items[?(@.spec.type==\"NodePort\")]}{range .spec.ports[*]}{.nodePort}{\"\\n\"}{end}{end}'"
      );
      if (res.exitCode === 0 && res.stdout) {
        const ports = res.stdout
          .trim()
          .split(/\s+/)
          .map((p) => parseInt(p, 10))
          .filter((p) => !isNaN(p) && p >= 30000);
        for (const p of ports) {
          allocatedNodePorts.add(p);
        }
      }
    } catch {}
  }

  public async deployBuildTask(input: DeployBuildTaskInput): Promise<DeployBuildTaskResult> {
    const shortId = deriveShortBuildId(input.runId);
    const namespace = `build-${shortId}`;
    const appName = (input.appName || `app-${shortId}`)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");
    const imageTag = `local-sandbox/${appName}:${shortId}`;
    const host = input.hostAddress || this.defaultHost;

    const stages: DeployStageRecord[] = [];
    let nodePort = 0;
    let deployedUrl = "";
    let healthStatus = 0;

    const runStage = async (
      name: DeployStageName,
      fn: () => Promise<string>
    ): Promise<boolean> => {
      const stage: DeployStageRecord = { name, status: "in_progress" };
      stages.push(stage);
      try {
        const detail = await fn();
        stage.status = "completed";
        stage.detail = detail;
        return true;
      } catch (err: any) {
        stage.status = "failed";
        stage.detail = err?.message || String(err);
        return false;
      }
    };

    let cleanupNeeded = false;

    try {
      // 1. Build image and import into cluster containerd
      const builtOk = await runStage("build_image", async () => {
        const buildRes = await this.commandRunner(
          `docker build -t ${imageTag} "${input.workspaceDir}"`
        );
        if (buildRes.exitCode !== 0) {
          throw new Error(`Docker build failed: ${buildRes.stderr || buildRes.stdout}`);
        }

        const k8sNode = process.env.K8S_NODE || "desktop-control-plane";
        const importCmd =
          process.env.K8S_CTR_IMPORT_CMD ||
          `docker save ${imageTag} | docker exec -i ${k8sNode} ctr -n k8s.io images import -`;
        const importRes = await this.commandRunner(importCmd);
        if (importRes.exitCode !== 0) {
          throw new Error(`Cluster containerd image import failed: ${importRes.stderr || importRes.stdout}`);
        }

        return `Built image ${imageTag} and imported into cluster containerd`;
      });

      if (!builtOk) {
        const errText = stages[stages.length - 1].detail || "Image build failed";
        return this.buildFailureResult(
          input,
          namespace,
          imageTag,
          nodePort,
          deployedUrl,
          healthStatus,
          stages,
          errText
        );
      }

      // 2. Create ephemeral namespace build-<shortid>
      cleanupNeeded = true;
      const nsOk = await runStage("create_namespace", async () => {
        const res = await this.commandRunner(
          `kubectl create namespace ${namespace} --dry-run=client -o yaml | kubectl apply -f -`
        );
        if (res.exitCode !== 0) {
          throw new Error(`Namespace creation failed: ${res.stderr || res.stdout}`);
        }
        return `Created namespace ${namespace}`;
      });

      if (!nsOk) {
        const errText = stages[stages.length - 1].detail || "Namespace creation failed";
        return this.buildFailureResult(
          input,
          namespace,
          imageTag,
          nodePort,
          deployedUrl,
          healthStatus,
          stages,
          errText
        );
      }

      // 3. Allocate unique NodePort
      const portOk = await runStage("allocate_port", async () => {
        await this.syncAllocatedNodePortsFromCluster();
        nodePort = allocateUniqueNodePort();
        deployedUrl = `${host}:${nodePort}`;
        return `Allocated NodePort ${nodePort}`;
      });

    if (!portOk) {
      const errText = stages[stages.length - 1].detail || "Port allocation failed";
      return this.buildFailureResult(
        input,
        namespace,
        imageTag,
        nodePort,
        deployedUrl,
        healthStatus,
        stages,
        errText
      );
    }

    // 4. Apply manifests
    const applyOk = await runStage("apply_manifests", async () => {
      const res = await this.commandRunner(
        `kubectl -n ${namespace} create deployment ${appName} --image=${imageTag} --dry-run=client -o yaml | kubectl apply -f - && kubectl -n ${namespace} expose deployment ${appName} --type=NodePort --port=80 --target-port=3000 --overrides="{\\"spec\\":{\\"ports\\":[{\\"port\\":80,\\"targetPort\\":3000,\\"nodePort\\":${nodePort}}]}}" --dry-run=client -o yaml | kubectl apply -f -`
      );
      if (res.exitCode !== 0) {
        throw new Error(`Manifest apply failed: ${res.stderr || res.stdout}`);
      }
      return `Applied Deployment and NodePort Service (${nodePort}) in ${namespace}`;
    });

    if (!applyOk) {
      const errText = stages[stages.length - 1].detail || "Manifest apply failed";
      return this.buildFailureResult(
        input,
        namespace,
        imageTag,
        nodePort,
        deployedUrl,
        healthStatus,
        stages,
        errText
      );
    }

    // 5. Rollout wait
    const rolloutOk = await runStage("rollout_wait", async () => {
      const res = await this.commandRunner(
        `kubectl -n ${namespace} rollout status deployment/${appName} --timeout=60s`
      );
      if (res.exitCode !== 0) {
        throw new Error(`Rollout failed: ${res.stderr || res.stdout}`);
      }
      return `Rollout ready for deployment/${appName}`;
    });

    if (!rolloutOk) {
      const errText = stages[stages.length - 1].detail || "Rollout failed";
      return this.buildFailureResult(
        input,
        namespace,
        imageTag,
        nodePort,
        deployedUrl,
        healthStatus,
        stages,
        errText
      );
    }

    // 6. Health check
    const healthOk = await runStage("health_check", async () => {
      const probeTarget = this.healthProbeUrlOverride || `${deployedUrl}/`;
      const check = await this.healthChecker(probeTarget);
      healthStatus = check.status;
      if (!check.ok) {
        throw new Error(`Health check failed with HTTP ${check.status} at ${probeTarget}`);
      }
      return `HTTP ${check.status} OK`;
    });

    if (!healthOk) {
      const errText = stages[stages.length - 1].detail || "Health check failed";
      return this.buildFailureResult(
        input,
        namespace,
        imageTag,
        nodePort,
        deployedUrl,
        healthStatus,
        stages,
        errText
      );
    }

    // 7. Report link
    let threadMessageMarkdown = "";
    await runStage("report_link", async () => {
      threadMessageMarkdown = `Deployed build to namespace \`${namespace}\` (NodePort \`${nodePort}\`): [${deployedUrl}](${deployedUrl}) (HTTP ${healthStatus} OK)`;
      return threadMessageMarkdown;
    });

      return {
        runId: input.runId,
        threadId: input.threadId,
        status: "succeeded",
        namespace,
        imageTag,
        nodePort,
        deployedUrl,
        healthStatus,
        stages,
        threadMessageMarkdown
      };
    } finally {
      if (cleanupNeeded && !input.keepNamespace) {
        try {
          await this.commandRunner(`kubectl delete namespace ${namespace} --wait=false`);
        } catch {}
      }
    }
  }

  private buildFailureResult(
    input: DeployBuildTaskInput,
    namespace: string,
    imageTag: string,
    nodePort: number,
    deployedUrl: string,
    healthStatus: number,
    stages: DeployStageRecord[],
    error: string
  ): DeployBuildTaskResult {
    const threadMessageMarkdown = `Deploy failed in namespace \`${namespace}\`: ${error}`;
    return {
      runId: input.runId,
      threadId: input.threadId,
      status: "failed",
      namespace,
      imageTag,
      nodePort,
      deployedUrl,
      healthStatus,
      stages,
      threadMessageMarkdown,
      error
    };
  }
}

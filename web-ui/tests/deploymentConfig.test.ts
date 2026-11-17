import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

describe("Phase 3 — Item 1 & 3: Deployment Configuration Suite", () => {
  const findRepoRoot = (): string => {
    let cur = __dirname;
    while (cur !== path.dirname(cur)) {
      if (fs.existsSync(path.join(cur, "deploy/k8s/web-ui.yaml"))) {
        return cur;
      }
      cur = path.dirname(cur);
    }
    return path.resolve(__dirname, "../..");
  };

  it("deploy/k8s/web-ui.yaml configures read-only root filesystem with explicit non-root UID", () => {
    const root = findRepoRoot();
    const k8sDeployContent = fs.readFileSync(path.join(root, "deploy/k8s/web-ui.yaml"), "utf8");

    assert.ok(
      k8sDeployContent.includes("runAsNonRoot: true"),
      "deploy/k8s/web-ui.yaml must define runAsNonRoot: true"
    );
    assert.ok(
      k8sDeployContent.includes("runAsUser: 1001"),
      "deploy/k8s/web-ui.yaml must define explicit non-root runAsUser: 1001"
    );
  });

  it("web-ui/Dockerfile contains nextjs non-root user setup and chown static assets", () => {
    const root = findRepoRoot();
    const dockerfileContent = fs.readFileSync(path.join(root, "web-ui/Dockerfile"), "utf8");

    assert.ok(
      dockerfileContent.includes("addgroup --system --gid 1001 nodejs"),
      "Dockerfile must define nodejs group with gid 1001"
    );
    assert.ok(
      dockerfileContent.includes("adduser --system --uid 1001 nextjs"),
      "Dockerfile must define nextjs user with uid 1001"
    );
    assert.ok(
      dockerfileContent.includes("--chown=nextjs:nodejs"),
      "Dockerfile must set static asset ownership with --chown=nextjs:nodejs"
    );
    assert.ok(
      dockerfileContent.includes("USER nextjs"),
      "Dockerfile must declare USER nextjs"
    );
  });

  it("deploy/k8s/web-ui.yaml drops ALL capabilities in securityContext", () => {
    const root = findRepoRoot();
    const k8sDeployContent = fs.readFileSync(path.join(root, "deploy/k8s/web-ui.yaml"), "utf8");

    assert.ok(
      k8sDeployContent.includes("drop:") && k8sDeployContent.includes("- ALL"),
      "deploy/k8s/web-ui.yaml must contain drop ALL capabilities block"
    );
  });

  it("Makefile k8s-build builds with repo root context (-f web-ui/Dockerfile .)", () => {
    const root = findRepoRoot();
    const makefileContent = fs.readFileSync(path.join(root, "Makefile"), "utf8");

    assert.ok(
      makefileContent.includes("-f web-ui/Dockerfile ."),
      "Makefile k8s-build target must build with repo root context: -f web-ui/Dockerfile ."
    );
  });

  it("deploy/k8s/web-ui.yaml configures Swift-1.5-Qwen3.8-27B-IQ3_XS, swift-15-27b-mtp, or qwen3.8-flash-next-gyro-gyro-s model environment variables", () => {
    const root = findRepoRoot();
    const k8sDeployContent = fs.readFileSync(path.join(root, "deploy/k8s/web-ui.yaml"), "utf8");

    assert.ok(
      k8sDeployContent.includes("Swift-1.5-Qwen3.8-27B-IQ3_XS") ||
      k8sDeployContent.includes("swift-15-27b-mtp") ||
      k8sDeployContent.includes("qwen3.8-flash-next-gyro-gyro-s"),
      "deploy/k8s/web-ui.yaml must configure Swift-1.5-Qwen3.8-27B-IQ3_XS, swift-15-27b-mtp, or qwen3.8-flash-next-gyro-gyro-s"
    );
    assert.ok(
      k8sDeployContent.includes("MODEL_NAME"),
      "deploy/k8s/web-ui.yaml must set MODEL_NAME"
    );
  });
});

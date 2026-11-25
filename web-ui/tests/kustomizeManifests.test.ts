import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Installable-manifest completeness for deploy/k8s:
 * 1. Every manifest file in deploy/k8s (except kustomization.yaml itself) must
 *    be listed in the kustomization resources, so `kubectl kustomize` renders
 *    the whole topology.
 * 2. Every service endpoint referenced by web-ui.yaml env values must resolve
 *    to a Service defined in the rendered resource set (strata-service,
 *    host-runner-service, ...). A missing ExternalName service means pods boot
 *    with env pointing at names that do not exist in the namespace.
 */
describe("Kustomize manifest completeness suite", () => {
  const findRepoRoot = (): string => {
    let cur = __dirname;
    while (cur !== path.dirname(cur)) {
      if (fs.existsSync(path.join(cur, "deploy/k8s/kustomization.yaml"))) {
        return cur;
      }
      cur = path.dirname(cur);
    }
    return path.resolve(__dirname, "../..");
  };

  const k8sDir = path.join(findRepoRoot(), "deploy/k8s");

  const readResources = (): string[] => {
    const kustomization = fs.readFileSync(path.join(k8sDir, "kustomization.yaml"), "utf8");
    const resourcesBlock = kustomization.slice(kustomization.indexOf("resources:"));
    return resourcesBlock
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).trim());
  };

  it("every manifest in deploy/k8s is listed in kustomization resources", () => {
    const resources = readResources();
    const onDisk = fs
      .readdirSync(k8sDir)
      .filter((f) => f.endsWith(".yaml") && f !== "kustomization.yaml")
      .sort();
    const missing = onDisk.filter((f) => !resources.includes(f));
    assert.equal(
      missing.length,
      0,
      `Manifests present on disk but omitted from kustomization resources: ${missing.join(", ")}`
    );
  });

  it("host-runner-service.yaml and strata-service.yaml are in kustomization resources", () => {
    const resources = readResources();
    assert.ok(
      resources.includes("host-runner-service.yaml"),
      "kustomization must include host-runner-service.yaml (web-ui HOST_RUNNER_URL depends on it)"
    );
    assert.ok(
      resources.includes("strata-service.yaml"),
      "kustomization must include strata-service.yaml (web-ui LLM_BASE_URL depends on it)"
    );
  });

  it("every http service endpoint referenced by web-ui.yaml resolves to a Service in the resource set", () => {
    const webUi = fs.readFileSync(path.join(k8sDir, "web-ui.yaml"), "utf8");
    const endpoints = new Set<string>();
    for (const m of webUi.matchAll(/value:\s*"http:\/\/([A-Za-z0-9.-]+):\d+"/g)) {
      endpoints.add(m[1]);
    }
    assert.ok(endpoints.size > 0, "web-ui.yaml must reference at least one in-cluster service");

    const resources = readResources();
    for (const endpoint of endpoints) {
      let found = false;
      for (const file of resources) {
        const content = fs.readFileSync(path.join(k8sDir, file), "utf8");
        if (
          /kind:\s*Service/.test(content) &&
          new RegExp(`name:\\s*${endpoint}$`, "m").test(content)
        ) {
          found = true;
          break;
        }
      }
      assert.ok(
        found,
        `web-ui.yaml references http://${endpoint} but no Service named '${endpoint}' exists in the kustomize resource set`
      );
    }
  });
});

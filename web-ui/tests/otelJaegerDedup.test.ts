import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

describe("otel-collector manifest hygiene", () => {
  const repoRoot = path.resolve(__dirname, "../..");
  const obsPath = path.join(repoRoot, "deploy", "k8s", "observability.yaml");

  it("otel-collector Deployment declares exactly one container named otel-collector with required ports", () => {
    assert.ok(fs.existsSync(obsPath), "deploy/k8s/observability.yaml must exist");
    const raw = fs.readFileSync(obsPath, "utf8");

    // Split multi-document YAML
    const docs = raw.split(/^---\s*$/m);
    const deploymentDoc = docs.find((d) => /kind:\s*Deployment/.test(d) && /name:\s*otel-collector/.test(d));
    assert.ok(deploymentDoc, "otel-collector Deployment must exist in observability.yaml");

    const serviceDoc = docs.find((d) => /kind:\s*Service/.test(d) && /name:\s*otel-collector/.test(d));
    assert.ok(serviceDoc, "otel-collector Service must exist in observability.yaml");

    // Extract containers section from Deployment pod spec
    const containersMatch = deploymentDoc.match(/containers:\s*\r?\n([\s\S]*)/);
    assert.ok(containersMatch, "Deployment must declare containers");
    const containersBlock = containersMatch[1];

    // Count container entries (`- name: <name>` at container list indentation)
    const containerNames = [...containersBlock.matchAll(/^\s{8}-\s*name:\s*(\S+)/gm)].map((m) => m[1]);
    assert.equal(
      containerNames.length,
      1,
      `otel-collector pod spec must declare exactly 1 container, found ${containerNames.length}: ${containerNames.join(", ")}`
    );
    assert.equal(
      containerNames[0],
      "otel-collector",
      `Surviving container must be named otel-collector, found ${containerNames[0]}`
    );

    // Extract containerPorts from Deployment
    const containerPorts = new Set(
      [...containersBlock.matchAll(/containerPort:\s*(\d+)/g)].map((m) => Number(m[1]))
    );
    assert.ok(containerPorts.has(4318), "otel-collector container must expose OTLP HTTP port 4318");

    // Extract targetPorts from otel-collector Service
    const serviceTargetPorts = [...serviceDoc.matchAll(/targetPort:\s*(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(serviceTargetPorts.length > 0, "otel-collector Service must declare targetPorts");
    for (const port of serviceTargetPorts) {
      assert.ok(
        containerPorts.has(port),
        `otel-collector container must expose Service targetPort ${port}`
      );
    }
  });
});

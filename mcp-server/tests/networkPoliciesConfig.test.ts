import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

describe("NetworkPolicy GitHub CIDR Parameterization Suite", () => {
  const repoRoot = path.resolve(process.cwd(), "..");
  const valuesPath = path.join(repoRoot, "deploy/helm/local-agentic-sandbox/values.yaml");
  const templatePath = path.join(repoRoot, "deploy/helm/local-agentic-sandbox/templates/network-policies.yaml");
  const hasHelmConfig = fs.existsSync(valuesPath) && fs.existsSync(templatePath);

  it("defines githubCIDRs list in Helm values.yaml with default GitHub CIDRs", (t) => {
    if (!hasHelmConfig) {
      t.skip("Skipping in isolated container build context: deploy manifests not present");
      return;
    }
    assert.ok(fs.existsSync(valuesPath), "values.yaml must exist");
    const valuesContent = fs.readFileSync(valuesPath, "utf8");

    assert.ok(
      valuesContent.includes("githubCIDRs:"),
      "values.yaml must declare networkPolicies.githubCIDRs"
    );
    assert.ok(valuesContent.includes("140.82.112.0/20"), "Must include default CIDR 140.82.112.0/20");
    assert.ok(valuesContent.includes("192.30.252.0/22"), "Must include default CIDR 192.30.252.0/22");
    assert.ok(valuesContent.includes("185.199.108.0/22"), "Must include default CIDR 185.199.108.0/22");
  });

  it("parameterizes network-policies.yaml template using .Values.networkPolicies.githubCIDRs instead of hardcoded IPs", (t) => {
    if (!hasHelmConfig) {
      t.skip("Skipping in isolated container build context: deploy manifests not present");
      return;
    }
    assert.ok(fs.existsSync(templatePath), "template network-policies.yaml must exist");
    const templateContent = fs.readFileSync(templatePath, "utf8");

    // Must NOT have static hardcoded CIDR blocks inside network-policies template
    assert.equal(
      templateContent.includes("cidr: 140.82.112.0/20"),
      false,
      "Template must not contain hardcoded CIDR 140.82.112.0/20"
    );

    // Must iterate over .Values.networkPolicies.githubCIDRs
    assert.ok(
      templateContent.includes(".Values.networkPolicies.githubCIDRs"),
      "Template must iterate over .Values.networkPolicies.githubCIDRs"
    );
  });
});

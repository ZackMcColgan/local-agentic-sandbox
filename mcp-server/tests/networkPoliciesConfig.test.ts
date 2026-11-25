import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

/**
 * NetworkPolicy GitHub egress CIDR coverage against the canonical kustomize
 * manifests. The former Helm chart (deploy/helm/) was removed as stale and
 * unconsumed; deploy/k8s/network-policies.yaml is the single source of truth
 * for the GitHub-egress rule, so this suite pins the documented default CIDRs
 * in that manifest.
 */
describe("NetworkPolicy GitHub CIDR Coverage Suite", () => {
  const repoRoot = path.resolve(process.cwd(), "..");
  const policiesPath = path.join(repoRoot, "deploy/k8s/network-policies.yaml");

  it("deploy/k8s/network-policies.yaml exists in the canonical manifest set", () => {
    assert.ok(fs.existsSync(policiesPath), "deploy/k8s/network-policies.yaml must exist");
  });

  it("declares the documented GitHub egress CIDRs for git operations", () => {
    const content = fs.readFileSync(policiesPath, "utf8");
    assert.ok(
      content.includes("cidr: 140.82.112.0/20"),
      "Must include GitHub CIDR 140.82.112.0/20"
    );
    assert.ok(
      content.includes("cidr: 192.30.252.0/22"),
      "Must include GitHub CIDR 192.30.252.0/22"
    );
    assert.ok(
      content.includes("cidr: 185.199.108.0/22"),
      "Must include GitHub Pages CIDR 185.199.108.0/22"
    );
  });

  it("keeps the GitHub egress rule scoped to HTTPS only", () => {
    const content = fs.readFileSync(policiesPath, "utf8");
    assert.ok(
      content.includes("port: 443"),
      "GitHub egress rule must target HTTPS (port 443), not arbitrary ports"
    );
  });
});

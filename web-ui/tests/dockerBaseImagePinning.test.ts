import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");

const DOCKERFILES = [
  "web-ui/Dockerfile",
  "mcp-server/Dockerfile",
  "browser-mcp/Dockerfile",
  "deploy/builder-go/Dockerfile",
  "deploy/builder-node/Dockerfile",
  "deploy/builder-python/Dockerfile",
  "deploy/builder-rust/Dockerfile",
];

const DIGEST_PATTERN = /@sha256:[0-9a-f]{64}$/;

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

function fromLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .filter((line) => /^FROM\s+\S+/.test(line))
    .map((line) => line.replace(/^FROM\s+/, "").split(/\s+/)[0]);
}

describe("Board #60: Dockerfile base-image digest pinning", () => {
  it("every Dockerfile FROM line is pinned to an immutable sha256 digest", () => {
    for (const rel of DOCKERFILES) {
      const bases = fromLines(read(rel));
      assert.ok(bases.length > 0, `${rel} must declare at least one FROM`);
      for (const base of bases) {
        assert.ok(
          DIGEST_PATTERN.test(base),
          `${rel}: unpinned floating tag "${base}" must carry @sha256:<digest>`
        );
      }
    }
  });

  it("Go builder uses a supported Go release (>= 1.24), not EOL 1.23", () => {
    const line = fromLines(read("deploy/builder-go/Dockerfile"))[0];
    assert.match(line, /^golang:1\.(2[4-9]|[3-9]\d)-bookworm@sha256:/, `got ${line}`);
  });

  it("Rust builder uses a supported Rust release (>= 1.85), not aged 1.80", () => {
    const line = fromLines(read("deploy/builder-rust/Dockerfile"))[0];
    assert.match(line, /^rust:1\.(8[5-9]|9\d|\d{3})-slim-bookworm@sha256:/, `got ${line}`);
  });

  it("Node version is aligned to the .nvmrc LTS (22) across every Node service", () => {
    const nvmrc = read(".nvmrc").trim();
    const major = nvmrc.split(".")[0];
    const nodeFiles = [
      "web-ui/Dockerfile",
      "mcp-server/Dockerfile",
      "browser-mcp/Dockerfile",
      "deploy/builder-node/Dockerfile",
    ];
    for (const rel of nodeFiles) {
      for (const base of fromLines(read(rel))) {
        assert.match(
          base,
          new RegExp(`^node:${major}-(alpine|bookworm-slim)@sha256:`),
          `${rel}: base "${base}" must align to node:${major} from .nvmrc`
        );
      }
    }
  });

  it("root .dockerignore exists and excludes node_modules, .git, and test artifacts", () => {
    const ignorePath = path.join(repoRoot, ".dockerignore");
    assert.ok(fs.existsSync(ignorePath), "root .dockerignore must exist");
    const patterns = read(ignorePath)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    for (const required of ["node_modules", ".git", "test-results", "playwright-report"]) {
      assert.ok(
        patterns.some((p) => p === required || p.startsWith(`${required}/`)),
        `.dockerignore must exclude ${required}`
      );
    }
  });
});

describe("Board #60: k8s manifest hardening", () => {
  it("observability.yaml pod spec declares a hardened securityContext", () => {
    const raw = read("deploy/k8s/observability.yaml");
    const deploymentDoc = raw
      .split(/^---\s*$/m)
      .find((d) => /kind:\s*Deployment/.test(d) && /name:\s*otel-collector/.test(d));
    assert.ok(deploymentDoc, "otel-collector Deployment must exist");

    assert.match(
      deploymentDoc,
      /runAsNonRoot:\s*true/,
      "otel-collector pod spec must run as non-root"
    );
    assert.match(
      deploymentDoc,
      /seccompProfile:\s*\r?\n\s*type:\s*RuntimeDefault/,
      "otel-collector pod spec must set seccompProfile RuntimeDefault"
    );
    assert.match(
      deploymentDoc,
      /allowPrivilegeEscalation:\s*false/,
      "otel-collector container must disallow privilege escalation"
    );
    assert.match(deploymentDoc, /drop:\s*\r?\n\s*-\s*ALL/, "must drop ALL capabilities");
  });

  it("qdrant initContainer image is pinned to a digest (no busybox:latest)", () => {
    const raw = read("deploy/k8s/qdrant.yaml");
    const initBlock = raw.slice(
      raw.indexOf("initContainers:"),
      raw.indexOf("containers:", raw.indexOf("initContainers:"))
    );
    const image = initBlock.match(/image:\s*(\S+)/)?.[1];
    assert.ok(image, "initContainer must declare an image");
    assert.ok(!/busybox:latest/.test(image), `initContainer image "${image}" must not be latest`);
    assert.ok(DIGEST_PATTERN.test(image), `initContainer image "${image}" must pin a digest`);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

describe("Board #120 Repository Standards Sweep (community files, dependency watching, environment consistency)", () => {
  const repoRoot = path.resolve(__dirname, "../..");

  const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), "utf8");
  const exists = (rel: string): boolean => fs.existsSync(path.join(repoRoot, rel));

  it("SECURITY.md exists and documents private vulnerability reporting plus the LAN bridge caveat", () => {
    assert.ok(exists("SECURITY.md"), "SECURITY.md must exist in repo root");
    const content = read("SECURITY.md");
    assert.ok(content.length > 100, "SECURITY.md must be non-trivial");
    assert.match(content, /security advis|private vulnerability reporting/i);
    assert.match(content, /supported versions/i);
    assert.match(content, /lan-bridge|local network/i);
    assert.doesNotMatch(
      content,
      /@[a-z0-9.]+\.(com|net|org)/i,
      "SECURITY.md must not embed personal email addresses"
    );
  });

  it("CONTRIBUTING.md exists and states the branch flow, Node pin, and the change-aware gate", () => {
    assert.ok(exists("CONTRIBUTING.md"), "CONTRIBUTING.md must exist in repo root");
    const content = read("CONTRIBUTING.md");
    assert.match(content, /feature\/\*|feature branch/i);
    assert.match(content, /npm run test:gate/);
    assert.match(content, /never run `npm run test`|do not run `npm run test`/i);
    assert.match(content, /\.nvmrc|Node 22/);
    assert.match(content, /prettier/i);
    assert.match(content, /eslint/i);
  });

  it("pull request template exists with the audit checklist", () => {
    const p = ".github/PULL_REQUEST_TEMPLATE.md";
    assert.ok(exists(p), "pull request template must exist under .github/");
    const content = read(p);
    assert.match(content, /npm run test:gate/);
    assert.match(content, /\[ \]/, "template must contain checklist boxes");
    assert.match(content, /develop/, "template must reference the develop target branch");
  });

  it("issue templates exist (bug report, feature request) with a form config", () => {
    const dir = ".github/ISSUE_TEMPLATE";
    assert.ok(exists(dir), "ISSUE_TEMPLATE directory must exist");
    const files = fs.readdirSync(path.join(repoRoot, dir));
    assert.ok(
      files.some((f) => /bug/i.test(f)),
      "a bug report template must exist"
    );
    assert.ok(
      files.some((f) => /feature|enhancement/i.test(f)),
      "a feature request template must exist"
    );
    assert.ok(files.includes("config.yml"), "ISSUE_TEMPLATE/config.yml must exist");
    const bug = read(
      path.join(
        dir,
        files.find((f) => /bug/i.test(f))!
      )
    );
    assert.match(bug, /name:/);
    assert.match(bug, /steps to reproduce/i);
  });

  it("dependabot.yml watches npm and GitHub Actions on a weekly cadence", () => {
    const p = ".github/dependabot.yml";
    assert.ok(exists(p), ".github/dependabot.yml must exist");
    const content = read(p);
    assert.match(content, /package-ecosystem:\s*"npm"/);
    assert.match(content, /package-ecosystem:\s*"github-actions"/);
    assert.match(content, /interval:\s*"weekly"/);
    // Every npm workspace directory is covered.
    for (const dir of ["web-ui", "mcp-server", "browser-mcp", "host-bridge"]) {
      assert.ok(content.includes(dir), `dependabot must cover the ${dir} workspace`);
    }
  });

  it(".editorconfig exists and agrees with the prettier config", () => {
    assert.ok(exists(".editorconfig"), ".editorconfig must exist");
    const ec = read(".editorconfig");
    assert.match(ec, /charset\s*=\s*utf-8/);
    assert.match(ec, /end_of_line\s*=\s*lf/);
    assert.match(ec, /indent_style\s*=\s*space/);
    assert.match(ec, /indent_size\s*=\s*2/);
    assert.match(ec, /insert_final_newline\s*=\s*true/);
    const prettier = JSON.parse(read(".prettierrc.json"));
    assert.equal(prettier.tabWidth, 2, "prettier tabWidth must match editorconfig indent_size");
    assert.equal(
      prettier.endOfLine,
      "lf",
      "prettier endOfLine must match editorconfig end_of_line"
    );
  });

  it(".gitattributes normalizes line endings for Windows development and Linux CI", () => {
    assert.ok(exists(".gitattributes"), ".gitattributes must exist");
    const content = read(".gitattributes");
    assert.match(content, /text=auto/);
    assert.match(content, /eol=lf/);
    assert.match(content, /\.png binary/);
    assert.match(content, /package-lock\.json/i);
  });

  it("Node version is pinned in one place: .nvmrc, engines, and CI reads the pin", () => {
    assert.ok(exists(".nvmrc"), ".nvmrc must exist");
    const pinned = read(".nvmrc").trim();
    assert.match(pinned, /^22\.\d+\.\d+$/, ".nvmrc must pin a Node 22.x patch version");

    const rootPkg = JSON.parse(read("package.json"));
    const webUiPkg = JSON.parse(read(path.join("web-ui", "package.json")));
    assert.equal(rootPkg.engines?.node, `>=${pinned}`, "root engines must match .nvmrc");
    assert.equal(webUiPkg.engines?.node, `>=${pinned}`, "web-ui engines must match .nvmrc");

    for (const wf of [".github/workflows/ci.yml", ".github/workflows/chaos.yml"]) {
      const content = read(wf);
      assert.match(
        content,
        /node-version-file:\s*"?\.nvmrc"?/,
        `${wf} must consume the .nvmrc pin`
      );
      assert.doesNotMatch(
        content,
        /node-version:\s*22\b/,
        `${wf} must not hardcode a floating node-version`
      );
    }
  });

  it("README carries a CI status badge pointing at the develop branch", () => {
    const content = read("README.md");
    assert.match(content, /img\.shields\.io\/github\/actions\/workflow\/status/);
    assert.match(content, /ci\.yml/);
    assert.match(content, /branch=develop/);
  });
});

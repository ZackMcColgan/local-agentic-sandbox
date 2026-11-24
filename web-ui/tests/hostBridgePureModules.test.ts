import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeBridgeSourceSha256,
  getBridgeManifest,
  PROTOCOL_VERSION,
} from "../../host-bridge/manifest";
import { applyReplaceString, countOccurrences } from "../../host-bridge/replaceString";
import { checkCommandDialect } from "../../host-bridge/dialectGuard";
import { isBinaryFile, readMultipleFiles } from "../../host-bridge/multiRead";

describe("Host Bridge Pure Modules (T-2)", () => {
  it("computeBridgeSourceSha256 is deterministic across CRLF vs LF and skips dist/scripts/manifest.json", () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "hb-manifest-a-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "hb-manifest-b-"));
    try {
      fs.writeFileSync(
        path.join(dirA, "server.ts"),
        "export const x = 1;\nexport const y = 2;\n",
        "utf8"
      );
      fs.writeFileSync(
        path.join(dirB, "server.ts"),
        "export const x = 1;\r\nexport const y = 2;\r\n",
        "utf8"
      );
      // Ignored files/dirs should not affect digest
      fs.mkdirSync(path.join(dirA, "dist"), { recursive: true });
      fs.writeFileSync(path.join(dirA, "dist", "bundle.js"), "console.log('ignored');", "utf8");
      fs.writeFileSync(
        path.join(dirA, "manifest.json"),
        '{"protocolVersion":1,"bridgeSourceSha256":"abc"}',
        "utf8"
      );

      const shaA = computeBridgeSourceSha256(dirA);
      const shaB = computeBridgeSourceSha256(dirB);
      assert.match(shaA, /^[0-9a-f]{64}$/);
      assert.equal(
        shaA,
        shaB,
        "Digest must normalize CRLF to LF and ignore dist/ and manifest.json"
      );

      // Modifying a tracked source file changes the digest
      fs.writeFileSync(path.join(dirB, "server.ts"), "export const x = 99;\n", "utf8");
      const shaModified = computeBridgeSourceSha256(dirB);
      assert.notEqual(shaModified, shaA);

      // getBridgeManifest reads manifest.json when present in baseDir
      const manifest = getBridgeManifest(dirA);
      assert.equal(manifest.protocolVersion, PROTOCOL_VERSION);
      assert.equal(manifest.bridgeSourceSha256, "abc");
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("applyReplaceString preserves literal $ sequences and rejects ambiguous matches unless replaceAll=true", () => {
    assert.equal(countOccurrences("a b a b a", "a"), 3);
    assert.equal(countOccurrences("hello", ""), 0);

    const dollarRes = applyReplaceString("const price = 10;", "10", "$& + $1 + $$");
    assert.equal(dollarRes.success, true);
    assert.equal(dollarRes.content, "const price = $& + $1 + $$;");
    assert.equal(dollarRes.replacements, 1);

    const ambiguous = applyReplaceString("foo bar foo", "foo", "baz", false);
    assert.equal(ambiguous.success, false);
    assert.equal(ambiguous.occurrences, 2);

    const all = applyReplaceString("foo bar foo", "foo", "baz", true);
    assert.equal(all.success, true);
    assert.equal(all.content, "baz bar baz");
    assert.equal(all.replacements, 2);
  });

  it("checkCommandDialect flags bashisms in PowerShell and PowerShell cmdlets in bash", () => {
    assert.equal(checkCommandDialect("Get-ChildItem -Path .", "powershell").ok, true);
    assert.equal(checkCommandDialect("export FOO=bar", "powershell").ok, false);
    assert.equal(checkCommandDialect("echo a && echo b", "powershell").ok, false);
    assert.equal(checkCommandDialect("ls -la", "bash").ok, true);
    assert.equal(checkCommandDialect("Get-ChildItem", "bash").ok, false);
    assert.equal(checkCommandDialect("echo $env:PATH", "bash").ok, false);
    const cmdRes = checkCommandDialect("dir", "cmd");
    assert.equal(cmdRes.ok, true);
    assert.equal(cmdRes.noRules, true);
  });

  it("multiRead detects binary files and skips excluded directories while reading text files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-multiread-"));
    try {
      const txtFile = path.join(dir, "hello.ts");
      const binFile = path.join(dir, "data.bin");
      const nulFile = path.join(dir, "sniff.txt");
      fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
      fs.writeFileSync(txtFile, "export const hello = 'world';\n", "utf8");
      fs.writeFileSync(binFile, Buffer.from([0x01, 0x02, 0x03]));
      fs.writeFileSync(nulFile, Buffer.from([0x41, 0x00, 0x42]));
      fs.writeFileSync(path.join(dir, "node_modules", "ignored.ts"), "ignored", "utf8");

      assert.equal(isBinaryFile(txtFile), false);
      assert.equal(isBinaryFile(binFile), true);
      assert.equal(isBinaryFile(nulFile), true);

      const res = readMultipleFiles(["."], dir);
      const readPaths = res.files.map((f) => f.path);
      assert.ok(readPaths.some((p) => p.endsWith("hello.ts")));
      assert.ok(!readPaths.some((p) => p.includes("node_modules")));
      assert.ok(!readPaths.some((p) => p.endsWith("data.bin")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { assertSacrificialTarget, PROD_HOST_RUNNER_PORT, PROD_CONFIG_DIR } from "../lib/lifecycleTargetGuard";

describe("PART C — Lifecycle Target Hard Guard Unit Tests", () => {
  it("1. Refuses production port 8765 immediately", () => {
    assert.throws(
      () => {
        assertSacrificialTarget({ port: 8765, configDir: os.tmpdir() });
      },
      {
        message: /Production target guard rejection: port 8765 is the protected production host runner port/
      }
    );

    assert.equal(PROD_HOST_RUNNER_PORT, 8765);
  });

  it("2. Refuses production config directory C:\\AI\\ai-control and its subpaths", () => {
    const prodPaths = [
      "C:\\AI\\ai-control",
      "C:/AI/ai-control",
      "c:\\ai\\ai-control",
      "C:\\AI\\ai-control\\bin",
      "C:\\AI\\ai-control\\bin\\host-runner.exe"
    ];

    for (const prodPath of prodPaths) {
      assert.throws(
        () => {
          assertSacrificialTarget({ port: 8799, configDir: prodPath });
        },
        {
          message: /Production target guard rejection: configDir touches protected production path/
        },
        `Expected refusal for path ${prodPath}`
      );
    }
  });

  it("3. Accepts sacrificial instance on non-production port with isolated temp directory", () => {
    const tempDir = path.join(os.tmpdir(), "sacrificial-test-dir");
    const result = assertSacrificialTarget({ port: 8799, configDir: tempDir });
    assert.equal(result.safe, true);
    assert.equal(result.port, 8799);
    assert.equal(result.configDir, tempDir);
  });

  it("4. Rejects invalid port ranges (e.g. privileged ports <= 1024 or > 65535)", () => {
    assert.throws(
      () => assertSacrificialTarget({ port: 80, configDir: os.tmpdir() }),
      { message: /Invalid port/ }
    );
    assert.throws(
      () => assertSacrificialTarget({ port: 70000, configDir: os.tmpdir() }),
      { message: /Invalid port/ }
    );
  });
});

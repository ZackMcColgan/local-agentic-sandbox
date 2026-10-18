import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import {
  handleControlRequest,
  createControlServer,
  ENGINE_STOPPED_MESSAGE
} from "../llamacpp-standalone.js";

function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          // not json
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on("error", reject);
    if (postData) {
      req.write(typeof postData === "string" ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

describe("Standalone llama.cpp Supervisor Control Endpoints", () => {
  const TEST_TOKEN = "test-secret-token-12345";
  let server;
  let serverPort;
  let state;
  let spawnCount = 0;
  let killCount = 0;

  function mockSpawn() {
    spawnCount++;
    const child = new EventEmitter();
    child.pid = 9999 + spawnCount;
    child.killed = false;
    child.kill = (sig) => {
      killCount++;
      child.killed = true;
      child.emit("exit", 0, sig || "SIGTERM");
    };
    state.childProc = child;
    state.spawnedAt = Date.now();
    state.status = "running";
    return child;
  }

  before((_, done) => {
    state = {
      status: "running",
      childProc: null,
      spawnedAt: Date.now() - 5000,
      model: "swift-15-27b-mtp",
      vramMb: 16384
    };
    mockSpawn();

    server = createControlServer(state, {
      controlToken: TEST_TOKEN,
      spawnFn: mockSpawn,
      backendPort: 19999
    });

    server.listen(0, "127.0.0.1", () => {
      serverPort = server.address().port;
      done();
    });
  });

  after((_, done) => {
    server.close(done);
  });

  it("rejects /control/status with 401 when X-Control-Token is missing", async () => {
    const res = await makeRequest({
      host: "127.0.0.1",
      port: serverPort,
      path: "/control/status",
      method: "GET"
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json?.status, "unauthorized");
  });

  it("rejects /control/status with 401 when X-Control-Token is incorrect", async () => {
    const res = await makeRequest({
      host: "127.0.0.1",
      port: serverPort,
      path: "/control/status",
      method: "GET",
      headers: { "X-Control-Token": "wrong-token" }
    });
    assert.equal(res.statusCode, 401);
  });

  it("returns full status info for GET /control/status with valid token", async () => {
    const res = await makeRequest({
      host: "127.0.0.1",
      port: serverPort,
      path: "/control/status",
      method: "GET",
      headers: { "X-Control-Token": TEST_TOKEN }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json?.status, "running");
    assert.ok(typeof res.json?.pid === "number");
    assert.ok(res.json?.uptime_s >= 0);
    assert.equal(res.json?.model, "swift-15-27b-mtp");
    assert.equal(res.json?.vram_mb, 16384);
  });

  it("POST /control/stop gracefully terminates child process and transitions to stopped", async () => {
    const initialKillCount = killCount;
    const res = await makeRequest({
      host: "127.0.0.1",
      port: serverPort,
      path: "/control/stop",
      method: "POST",
      headers: { "X-Control-Token": TEST_TOKEN }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json?.status, "stopped");
    assert.equal(killCount, initialKillCount + 1);
    assert.equal(state.status, "stopped");
    assert.equal(state.childProc, null);

    // Verify GET /control/status now reports stopped
    const statusRes = await makeRequest({
      host: "127.0.0.1",
      port: serverPort,
      path: "/control/status",
      method: "GET",
      headers: { "X-Control-Token": TEST_TOKEN }
    });
    assert.equal(statusRes.json?.status, "stopped");
    assert.equal(statusRes.json?.pid, null);
    assert.equal(statusRes.json?.uptime_s, 0);
  });

  it("returns 503 with friendly error for non-control requests while engine is stopped", async () => {
    const res = await makeRequest({
      host: "127.0.0.1",
      port: serverPort,
      path: "/v1/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json" }
    }, { model: "swift-15-27b-mtp", messages: [] });

    assert.equal(res.statusCode, 503);
    assert.equal(res.json?.error?.type, "engine_stopped");
    assert.equal(res.json?.error?.message, ENGINE_STOPPED_MESSAGE);
  });

  it("POST /control/start respawns child process and transitions to starting/running", async () => {
    const initialSpawnCount = spawnCount;
    const res = await makeRequest({
      host: "127.0.0.1",
      port: serverPort,
      path: "/control/start",
      method: "POST",
      headers: { "X-Control-Token": TEST_TOKEN }
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json?.status === "starting" || res.json?.status === "running");
    assert.equal(spawnCount, initialSpawnCount + 1);
    assert.equal(state.status, "running");
    assert.ok(state.childProc !== null);
  });
});

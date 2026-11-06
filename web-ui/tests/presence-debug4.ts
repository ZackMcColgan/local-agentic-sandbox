import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

async function main() {
  const tmp = path.join(os.tmpdir(), `dbg4-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  process.env.THREADS_DIR = tmp;

  const server = http.createServer(async (req, res) => {
    let acc = "";
    req.on("data", (c) => (acc += c));
    await new Promise((r) => req.on("end", r));
    let parsed: any = {};
    try { parsed = JSON.parse(acc); } catch {}
    const isOpenAI = String(req.url).startsWith("/v1");
    console.log(`ENGINE REQ: ${req.url} engine_hint=${isOpenAI ? "openai" : "ollama"} stream=${parsed.stream ?? "?"}`);
    res.writeHead(200, { "Content-Type": isOpenAI ? "text/event-stream" : "application/x-ndjson" });
    if (isOpenAI) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "thinking-ish" } }] })}\n\n`);
      await new Promise((r) => setTimeout(r, 600));
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: " FAKE OPENAI ANSWER" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
    } else {
      res.write(`${JSON.stringify({ message: { thinking: "thinking-ish " } })}\n`);
      await new Promise((r) => setTimeout(r, 600));
      res.write(`${JSON.stringify({ message: { content: "FAKE OLLAMA ANSWER" } })}\n`);
      res.write(`${JSON.stringify({ message: {}, done: true })}\n`);
    }
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r as any));
  const port = (server.address() as any).port;
  process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.LLAMACPP_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.LLM_ENGINE = "ollama";

  const { POST } = await import("../app/api/chat/route");
  const { GET } = await import("../app/api/threads/[id]/route");

  const threadId = "dbg4-thread";
  const res = await POST(new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId,
      userMessageId: "u1",
      assistantMessageId: "a1",
      messages: [{ role: "user", content: "hi", id: "u1" }],
      model: "auto",
      mode: "chat",
      enableTools: false
    })
  }) as any);

  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const t0 = Date.now();
  const events: string[] = [];
  const polls: string[] = [];
  const poll = setInterval(async () => {
    const data = await (await GET(new Request(`http://localhost/api/threads/${threadId}`), { params: Promise.resolve({ id: threadId }) } as any)).json();
    const asst = (data.thread?.messages || []).find((m: any) => m.role === "assistant");
    polls.push(`[${Date.now() - t0}ms] activeTurn=${!!data.activeTurn} asst=${asst ? `${asst.status}:${(asst.content || "").slice(0, 24)}` : "none"}`);
  }, 300);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
    for (const p of parts) {
      if (p.startsWith("data:")) {
        try {
          const ev = JSON.parse(p.slice(5));
          events.push(`[${Date.now() - t0}ms] ${ev.type}${ev.type === "done" ? " status=" + ev.status + " len=" + (ev.content || "").length : ""}${ev.type === "error" ? " " + String(ev.error).slice(0, 60) : ""}`);
        } catch {}
      }
    }
  }
  clearInterval(poll);
  await new Promise((r) => setTimeout(r, 500));
  console.log("EVENTS:"); events.forEach((e) => console.log(" ", e));
  console.log("POLLS:"); polls.forEach((p) => console.log(" ", p));
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("DEBUG4 OK");
}

main().catch((e) => { console.error("ERR:", e); process.exit(1); });

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

async function main() {
  const tmp = path.join(os.tmpdir(), `dbg3-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  process.env.THREADS_DIR = tmp;

  const server = http.createServer(async (req, res) => {
    let acc = "";
    req.on("data", (c) => (acc += c));
    await new Promise((r) => req.on("end", r));
    let parsed: any = {};
    try { parsed = JSON.parse(acc); } catch {}
    const first = typeof parsed.messages?.[0]?.content === "string" ? parsed.messages[0].content : "";
    console.log(`ENGINE REQ: path=${req.url} model=${parsed.model || "?"} first_msg_head=${first.slice(0, 50)}`);
    if (first.includes("complexity")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"complexity":"SIMPLE_EXECUTION","reasoning":"simple"}' } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking... " } }] })}\n\n`);
    await new Promise((r) => setTimeout(r, 700));
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "FINAL ANSWER TEXT" } }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r as any));
  const port = (server.address() as any).port;
  process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;

  const { POST } = await import("../app/api/chat/route");
  const { GET } = await import("../app/api/threads/[id]/route");
  const { getActiveTurn } = await import("../lib/threads/threadStore");

  const threadId = "dbg3-thread";
  const res = await POST(new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId,
      userMessageId: "u1",
      assistantMessageId: "a1",
      messages: [{ role: "user", content: "hello there", id: "u1" }],
      model: "auto",
      mode: "auto"
    })
  }) as any);
  console.log("POST status:", res.status, "presence:", JSON.stringify(getActiveTurn(threadId)));

  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const t0 = Date.now();
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
          console.log(`[${Date.now() - t0}ms] event=${ev.type}${ev.type === "token" ? " text=" + JSON.stringify(ev.text || ev.content || "").slice(0, 30) : ""}${ev.type === "done" ? " status=" + ev.status + " content_len=" + (ev.content || "").length : ""}${ev.type === "error" ? " err=" + String(ev.error).slice(0, 60) : ""}`);
        } catch {}
      }
    }
  }

  const data = await (await GET(new Request(`http://localhost/api/threads/${threadId}`), { params: Promise.resolve({ id: threadId }) } as any)).json();
  console.log("final activeTurn:", JSON.stringify(data.activeTurn));
  console.log("thread status:", data.thread?.status);
  for (const m of data.thread?.messages || []) {
    console.log("msg:", m.role, m.status, "content_len=" + (m.content || "").length, "head=" + JSON.stringify((m.content || "").slice(0, 40)));
  }
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("DEBUG3 EXIT OK");
}

main().catch((e) => { console.error("ERR:", e && e.message ? e.message : e); process.exit(1); });

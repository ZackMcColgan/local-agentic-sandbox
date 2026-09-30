# local-agentic-sandbox

A full-stack, air-gapped agentic AI platform orchestrating local LLMs via Ollama, Model Context Protocol (MCP), and hardened container sandboxes for safe autonomous code execution.

---

## Architecture Overview

- **Local Inference**: Ollama (`qwen3.8`) on an isolated internal network (`ai-mesh`).
- **Sandboxed MCP Server**: Unprivileged container (`uid: 10001`), read-only root filesystem, dropped Linux capabilities (`cap_drop: ALL`), ephemeral `tmpfs` execution buffer.
- **Web UI & Orchestrator**: Next.js 15 streaming interface with agent execution trace and sandbox governance monitoring.

---

## Google Antigravity & Docker Sandbox Integration

To run Google Antigravity (`agy`) inside a secure microVM sandbox with an internal Docker daemon, use Oleg Šelajev's kit:

```bash
# Launch Antigravity inside a Docker Sandbox
sbx run --kit git+https://github.com/shelajev/agy-sbx-kit.git agy .
```

---

## Quickstart

```bash
# 1. Pull the model into Ollama
docker compose up -d ollama
docker compose exec ollama ollama run qwen3.8

# 2. Build and launch all services
docker compose up --build -d

# 3. Test sandboxed execution
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Write a python script to calculate fibonacci up to 10 and run it."}]}'
```

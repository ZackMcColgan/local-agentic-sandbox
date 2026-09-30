.PHONY: all up down restart logs pull-model verify-sec clean help

all: help

help:
	@echo "local-agentic-sandbox - Management Commands"
	@echo "============================================"
	@echo "make pull-model    Start Ollama and pull qwen3.8 model"
	@echo "make up            Build and launch all services in detached mode"
	@echo "make down          Stop and remove all containers"
	@echo "make restart       Restart all services"
	@echo "make logs          Follow logs across all containers"
	@echo "make verify-sec    Test security boundary (UID & zero egress)"
	@echo "make clean         Stop containers and remove volumes"

pull-model:
	docker compose up -d ollama
	docker compose exec ollama ollama run qwen3.8

up:
	docker compose up --build -d

down:
	docker compose down

restart:
	docker compose restart

logs:
	docker compose logs -f

verify-sec:
	@echo "[*] Checking MCP server process UID (expected: 10001)..."
	docker compose exec mcp-server id
	@echo "[*] Verifying zero internet egress on ai-mesh (expected: unreachable)..."
	-docker compose exec mcp-server ping -c 1 8.8.8.8

clean:
	docker compose down -v --remove-orphans

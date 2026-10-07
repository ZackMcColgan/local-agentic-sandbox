.PHONY: all up down restart logs pull-model verify-sec clean help k8s-deploy k8s-build k8s-ingress

all: help

help:
	@echo "local-agentic-sandbox - Management Commands"
	@echo "============================================"
	@echo "make pull-primary  Pull primary orchestrator model (swift-27b-mtp)"
	@echo "make pull-subagent Pull fast execution sub-agent model (swift-27b-mtp)"
	@echo "make pull-all      Pull both primary and sub-agent models"
	@echo "make list-models   List locally installed Ollama models & VRAM usage"
	@echo "make up            Build and launch all services in detached mode"
	@echo "make down          Stop and remove all containers"
	@echo "make restart       Restart all services"
	@echo "make logs          Follow logs across all containers"
	@echo "make verify-sec    Test security boundary (UID & zero egress)"
	@echo "make test          Run full test suite (mcp-server & web-ui)"
	@echo "make test-coverage Run full test suite with code coverage reports"
	@echo "make clean         Stop containers and remove volumes"
	@echo "make k8s-build    Build web-ui image for Kubernetes"
	@echo "make k8s-deploy   Build image and rollout restart K8s web-ui"
	@echo "make k8s-ingress   One-time ingress-nginx install for port 80 access"

pull-primary:
	docker compose run --rm --network egress-mesh ollama ollama pull swift-27b-mtp

pull-subagent:
	docker compose run --rm --network egress-mesh ollama ollama pull swift-27b-mtp

pull-all: pull-primary pull-subagent

list-models:
	docker compose exec ollama ollama list

pull-model: pull-primary

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
	@echo "[*] Verifying zero internet egress on mcp-server (expected: unreachable)..."
	-docker compose exec mcp-server ping -c 1 8.8.8.8
	@echo "[*] Verifying zero internet egress on ollama (expected: unreachable)..."
	-docker compose exec ollama ping -c 1 8.8.8.8

test:
	@echo "=== Running MCP Server Tests ==="
	cd mcp-server && npm test
	@echo "=== Running Web UI Tests ==="
	cd web-ui && npm test

test-coverage:
	@echo "=== Running MCP Server Coverage ==="
	cd mcp-server && npm run test:coverage
	@echo "=== Running Web UI Coverage ==="
	cd web-ui && npm run test:coverage

clean:
	docker compose down -v --remove-orphans

# Kubernetes deployment (Docker Desktop)
# Builds the web-ui image locally and restarts the K8s deployment.
# Image uses imagePullPolicy: Never, so the local build is picked up directly.
k8s-build:
	docker build -t local-agentic-sandbox-web-ui:v2.7-unified -f web-ui/Dockerfile web-ui

k8s-deploy: k8s-build
	kubectl rollout restart deployment/web-ui -n local-agentic-sandbox
	kubectl rollout status deployment/web-ui -n local-agentic-sandbox --timeout=300s

# One-time ingress controller install (Docker Desktop).
# Binds host ports 80/443 so http://<PC-IP>/ reaches web-ui with no port-forward.
k8s-ingress:
	kubectl apply -k deploy/k8s/ingress-nginx
	kubectl wait --namespace ingress-nginx --for=condition=ready pod --selector=app.kubernetes.io/component=controller --timeout=180s

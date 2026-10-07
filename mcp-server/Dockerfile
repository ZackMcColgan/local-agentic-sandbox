# ==========================================
# Stage 1: Builder
# ==========================================
FROM node:22-alpine AS builder

RUN apk add --no-cache git python3

WORKDIR /build

# Copy entire monorepo structure
COPY package*.json ./
COPY mcp-server/package*.json ./mcp-server/
COPY mcp-server/tsconfig.json ./mcp-server/
COPY mcp-server/src ./mcp-server/src
COPY mcp-server/tests ./mcp-server/tests

# Install from root (honors workspace config)
RUN npm ci --workspaces

WORKDIR /build/mcp-server
RUN npm run build

# Prune dev dependencies for a lean production footprint
RUN npm prune --production

# ==========================================
# Stage 2: Hardened Runtime Environment
# ==========================================
FROM node:22-alpine AS runner

# Install Python3, pytest, git, bash, and ripgrep for autonomous workspace operations
RUN apk update && \
    apk add --no-cache python3 py3-pip py3-pytest git bash ripgrep && \
    rm -rf /var/cache/apk/*

WORKDIR /app

# Create unprivileged sandbox user and group (UID/GID: 10001) and setup /workspace
RUN addgroup -g 10001 -S sandbox && \
    adduser -u 10001 -S sandbox -G sandbox && \
    mkdir -p /workspace && \
    chown -R 10001:10001 /workspace && \
    git config --system --add safe.directory '*' && \
    git config --system user.name "Autonomous Agent" && \
    git config --system user.email "agent@local-sandbox.internal"

# Copy build artifacts, production modules, and source/tests
COPY --from=builder /build/mcp-server/package.json ./package.json
COPY --from=builder /build/mcp-server/node_modules ./node_modules
COPY --from=builder /build/mcp-server/dist ./dist
COPY --from=builder /build/mcp-server/src ./src
COPY --from=builder /build/mcp-server/tests ./tests

# Ensure the app files are owned by the sandbox user and read-only
RUN chown -R 10001:10001 /app && \
    chmod -R 555 /app

# Switch to unprivileged execution user
USER 10001:10001

EXPOSE 8080

ENV NODE_ENV=production \
    PORT=8080 \
    PYTHONUNBUFFERED=1

CMD ["node", "dist/index.js"]

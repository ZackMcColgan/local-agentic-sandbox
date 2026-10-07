# ==========================================
# Stage 1: Builder
# ==========================================
FROM node:22-alpine AS builder

WORKDIR /build

# Copy entire monorepo structure
COPY package*.json ./
COPY browser-mcp/package*.json ./browser-mcp/
COPY browser-mcp/tsconfig.json ./browser-mcp/
COPY browser-mcp/src ./browser-mcp/src

# Install from root (honors workspace config)
RUN npm ci --workspaces

WORKDIR /build/browser-mcp
RUN npm run build

# Prune dev dependencies for production
RUN npm prune --production

# ==========================================
# Stage 2: Hardened Runtime Environment
# ==========================================
FROM node:22-alpine AS runner

WORKDIR /app

# Create unprivileged browser-agent user (UID/GID: 10002)
RUN addgroup -g 10002 -S browseragent && \
    adduser -u 10002 -S browseragent -G browseragent

# Copy build artifacts and production modules
COPY --from=builder /build/browser-mcp/package.json ./package.json
COPY --from=builder /build/browser-mcp/node_modules ./node_modules
COPY --from=builder /build/browser-mcp/dist ./dist

# Read-only application binary protection
RUN chown -R 10002:10002 /app && \
    chmod -R 555 /app

# Switch to unprivileged execution user
USER 10002:10002

EXPOSE 8081

ENV NODE_ENV=production \
    PORT=8081

CMD ["node", "dist/index.js"]

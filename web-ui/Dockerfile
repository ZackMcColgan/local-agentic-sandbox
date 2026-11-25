# ==========================================
# Stage 1: Install dependencies
# ==========================================
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /build

# Copy entire monorepo structure
COPY package*.json ./
COPY web-ui/package*.json ./web-ui/
COPY mcp-server/package*.json ./mcp-server/
COPY browser-mcp/package*.json ./browser-mcp/
COPY host-bridge/package*.json ./host-bridge/

# Install from root (honors workspace config).
# --ignore-scripts: the root prepare script installs git hooks, which are
# meaningless inside an image (nothing commits here); without this flag the
# build fails on "husky: not found" (exit 127).
RUN npm ci --workspaces --ignore-scripts

# ==========================================
# Stage 2: Build Next.js application
# ==========================================
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS builder
WORKDIR /build

COPY --from=deps /build/node_modules ./node_modules
COPY --from=deps /build/node_modules ./web-ui/node_modules
COPY package*.json ./
COPY web-ui ./web-ui
COPY host-bridge ./host-bridge

WORKDIR /build/web-ui

# Set production environment variable for build
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

RUN npm run build

# ==========================================
# Stage 3: Production Runner (Lean Standalone)
# ==========================================
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS runner
RUN apk update && \
    apk upgrade --no-cache && \
    apk add --no-cache git && \
    git config --system --add safe.directory '*' && \
    rm -rf /var/cache/apk/*
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME="0.0.0.0" \
    NEXT_TELEMETRY_DISABLED=1 \
    WORKSPACE_DIR=/workspace

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone build output
COPY --from=builder /build/web-ui/public ./public
COPY --from=builder /build/web-ui/public ./web-ui/public
COPY --from=builder --chown=nextjs:nodejs /build/web-ui/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /build/web-ui/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /build/web-ui/.next/static ./web-ui/.next/static

USER nextjs

EXPOSE 3000

CMD ["node", "web-ui/server.js"]

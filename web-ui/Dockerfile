# ==========================================
# Stage 1: Install dependencies
# ==========================================
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /build

# Copy entire monorepo structure
COPY package*.json ./
COPY web-ui/package*.json ./web-ui/

# Install from root (honors workspace config)
RUN npm ci --workspaces

# ==========================================
# Stage 2: Build Next.js application
# ==========================================
FROM node:22-alpine AS builder
WORKDIR /build

COPY --from=deps /build/node_modules ./node_modules
COPY --from=deps /build/node_modules ./web-ui/node_modules
COPY package*.json ./
COPY web-ui ./web-ui

WORKDIR /build/web-ui

# Set production environment variable for build
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

RUN npm run build

# ==========================================
# Stage 3: Production Runner (Lean Standalone)
# ==========================================
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME="0.0.0.0" \
    NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone build output
COPY --from=builder /build/web-ui/public ./public
COPY --from=builder --chown=nextjs:nodejs /build/web-ui/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /build/web-ui/.next/static ./.next/static

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]

# ==========================================
# Stage 1: Install dependencies
# ==========================================
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package*.json ./
RUN npm install


# ==========================================
# Stage 2: Build Next.js application
# ==========================================
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Set production environment variable for build
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

RUN npm run build && \
    npx tsc lib/subagents/schedulerDaemon.ts --outDir dist --rootDir . --target ES2022 --module CommonJS --moduleResolution node --esModuleInterop --skipLibCheck

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
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Compiled scheduler daemon (plain-node entrypoint, not part of the Next bundle)
COPY --from=builder --chown=nextjs:nodejs /app/dist ./dist
# Full node_modules: the daemon's compiled output requires() runtime packages
# (@langchain/langgraph, typescript, @opentelemetry/api) that the standalone
# trace does not include. Local image; correctness over leanness.
COPY --from=deps --chown=nextjs:nodejs /app/node_modules ./node_modules

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]

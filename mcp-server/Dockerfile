# ==========================================
# Stage 1: Builder
# ==========================================
FROM node:22-alpine AS builder

RUN apk add --no-cache git python3

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
COPY tests ./tests
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
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src
COPY --from=builder /app/tests ./tests

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

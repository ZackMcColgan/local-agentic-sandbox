# Pre-baked Builder Toolchain: Node.js 22 LTS
# Deterministic build environment with package registry allowlist
FROM node:22-bookworm-slim

# Install system utilities needed for building & git operations
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create unprivileged builder user
RUN groupadd -g 10001 builder && \
    useradd -u 10001 -g builder -m -s /bin/bash builder

# Configure build cache mount paths
ENV npm_config_cache=/build-cache/npm
ENV YARN_CACHE_FOLDER=/build-cache/yarn
ENV PNPM_HOME=/build-cache/pnpm

RUN mkdir -p /build-cache/npm /build-cache/yarn /build-cache/pnpm /workspace && \
    chown -R 10001:10001 /build-cache /workspace

USER 10001:10001
WORKDIR /workspace

CMD ["/bin/bash"]

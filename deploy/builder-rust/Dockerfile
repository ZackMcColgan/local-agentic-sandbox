# Pre-baked Builder Toolchain: Rust
# Deterministic build environment with Crates.io allowlist
FROM rust:1.80-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 10001 builder && \
    useradd -u 10001 -g builder -m -s /bin/bash builder

ENV CARGO_HOME=/build-cache/cargo

RUN mkdir -p /build-cache/cargo /workspace && \
    chown -R 10001:10001 /build-cache /workspace

USER 10001:10001
WORKDIR /workspace

CMD ["/bin/bash"]

# Pre-baked Builder Toolchain: Go 1.23
# Deterministic build environment with Go proxy allowlist
FROM golang:1.23-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 10001 builder && \
    useradd -u 10001 -g builder -m -s /bin/bash builder

ENV GOCACHE=/build-cache/go/build
ENV GOMODCACHE=/build-cache/go/mod
ENV GOPROXY=https://proxy.golang.org,direct

RUN mkdir -p /build-cache/go/build /build-cache/go/mod /workspace && \
    chown -R 10001:10001 /build-cache /workspace

USER 10001:10001
WORKDIR /workspace

CMD ["/bin/bash"]

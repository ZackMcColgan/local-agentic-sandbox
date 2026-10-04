# Pre-baked Builder Toolchain: Python 3.12
# Deterministic build environment with PyPI allowlist
FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 10001 builder && \
    useradd -u 10001 -g builder -m -s /bin/bash builder

ENV PIP_CACHE_DIR=/build-cache/pip
ENV POETRY_CACHE_DIR=/build-cache/poetry

RUN mkdir -p /build-cache/pip /build-cache/poetry /workspace && \
    chown -R 10001:10001 /build-cache /workspace

USER 10001:10001
WORKDIR /workspace

CMD ["/bin/bash"]

# syntax=docker/dockerfile:1.7
FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8

ARG SEEDBED_TARBALL=gnolith-seedbed-0.1.1.tgz
ARG DIAMOND_TARBALL=gnolith-diamond-0.4.0.tgz
ARG TAPROOT_TARBALL=gnolith-taproot-0.2.0.tgz
ARG WORKSHOP_TARBALL=gnolith-workshop-0.2.3.tgz
ARG SOURCE_URL=https://github.com/gnolith/seedbed
ARG REVISION=unknown
LABEL org.opencontainers.image.source=$SOURCE_URL \
      org.opencontainers.image.revision=$REVISION \
      org.opencontainers.image.title="Gnolith Seedbed" \
      org.opencontainers.image.description="Headless Gnolith MCP stdio process" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
    && apt-get install --yes --no-install-recommends tini=0.19.0-1+b3 \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node /opt/seedbed /var/lib/seedbed
WORKDIR /opt/seedbed
COPY gnolith-*.tgz /tmp/packages/
RUN test -f "/tmp/packages/${SEEDBED_TARBALL}" \
    && test -f "/tmp/packages/${DIAMOND_TARBALL}" \
    && test -f "/tmp/packages/${TAPROOT_TARBALL}" \
    && test -f "/tmp/packages/${WORKSHOP_TARBALL}" \
    && npm install --omit=dev --ignore-scripts --no-audit --no-fund \
      "/tmp/packages/${DIAMOND_TARBALL}" \
      "/tmp/packages/${TAPROOT_TARBALL}" \
      "/tmp/packages/${WORKSHOP_TARBALL}" \
      "/tmp/packages/${SEEDBED_TARBALL}" \
    && rm -rf /tmp/packages \
    && npm cache clean --force

USER node:node
ENV NODE_ENV=production \
    SEEDBED_DATABASE_PATH=/var/lib/seedbed/gnolith.sqlite
VOLUME ["/var/lib/seedbed"]
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/seedbed/node_modules/.bin/seedbed"]
CMD ["mcp", "--stdio"]

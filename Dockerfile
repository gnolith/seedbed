# syntax=docker/dockerfile:1.7
FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8

ARG PRODUCTION_CLOSURE=gnolith-production-closure.tar.gz
ARG PRODUCTION_CLOSURE_SHA256
ARG SOURCE_URL=https://github.com/gnolith/seedbed
ARG REVISION=unknown
LABEL org.opencontainers.image.source=$SOURCE_URL \
      org.opencontainers.image.revision=$REVISION \
      org.opencontainers.image.title="Gnolith Seedbed" \
      org.opencontainers.image.description="Headless Gnolith MCP stdio process" \
      org.opencontainers.image.licenses="MIT" \
      org.gnolith.production-closure.sha256=$PRODUCTION_CLOSURE_SHA256

RUN apt-get update \
    && apt-get install --yes --no-install-recommends tini=0.19.0-1+b3 \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node /opt/seedbed /var/lib/seedbed
WORKDIR /opt/seedbed
COPY ${PRODUCTION_CLOSURE} /tmp/production-closure.tar.gz
RUN --network=none test -n "${PRODUCTION_CLOSURE_SHA256}" \
    && echo "${PRODUCTION_CLOSURE_SHA256}  /tmp/production-closure.tar.gz" | sha256sum --check \
    && tar -xzf /tmp/production-closure.tar.gz -C /opt/seedbed \
    && test -f /opt/seedbed/production-package-lock.json \
    && test -f /opt/seedbed/production-tree.json \
    && test -x /opt/seedbed/node_modules/.bin/seedbed \
    && rm /tmp/production-closure.tar.gz

USER node:node
ENV NODE_ENV=production \
    SEEDBED_DATABASE_PATH=/var/lib/seedbed/gnolith.sqlite
VOLUME ["/var/lib/seedbed"]
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/seedbed/node_modules/.bin/seedbed"]
CMD ["mcp", "--stdio"]

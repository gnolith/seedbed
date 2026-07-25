ARG NODE_IMAGE=node@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
FROM ${NODE_IMAGE} AS build

ARG DIAMOND_ARTIFACT
ARG DIAMOND_SHA256
ARG TAPROOT_ARTIFACT
ARG TAPROOT_SHA256
ARG WORKSHOP_ARTIFACT
ARG WORKSHOP_SHA256

WORKDIR /build
COPY ${DIAMOND_ARTIFACT} /build/components/gnolith-diamond-0.5.0.tgz
COPY ${TAPROOT_ARTIFACT} /build/components/gnolith-taproot-0.5.0.tgz
COPY ${WORKSHOP_ARTIFACT} /build/components/gnolith-workshop-0.5.0.tgz
COPY docker/assembly-package.json /build/package.json
COPY docker/assembly-package-lock.json /build/package-lock.json
RUN set -eu; \
    echo "${DIAMOND_SHA256}  /build/components/gnolith-diamond-0.5.0.tgz" | sha256sum -c -; \
    echo "${TAPROOT_SHA256}  /build/components/gnolith-taproot-0.5.0.tgz" | sha256sum -c -; \
    echo "${WORKSHOP_SHA256}  /build/components/gnolith-workshop-0.5.0.tgz" | sha256sum -c -; \
    npm ci --ignore-scripts --omit=dev --no-audit --no-fund; \
    npm cache clean --force

ARG NODE_IMAGE=node@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
RUN groupadd --system --gid 10001 gnolith \
 && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin gnolith \
 && mkdir -p /app /var/lib/gnolith \
 && chown -R 10001:10001 /app /var/lib/gnolith
COPY --from=build --chown=10001:10001 /build/node_modules /app/node_modules
COPY --chown=10001:10001 docker/operator-runner.mjs docker/workshop-local-adapter.mjs docker/opaque-codec.mjs docker/read-only-sql.mjs /app/seedbed/
COPY --chown=10001:10001 workshop.config.json assembly.config.json /app/seedbed/
ENV PATH="/app/node_modules/.bin:${PATH}"
WORKDIR /app
USER 10001:10001
EXPOSE 4317
ENTRYPOINT ["gnolith-workshop"]
CMD ["serve", "--config", "/app/seedbed/workshop.config.json"]

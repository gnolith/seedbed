import type { SeedbedConfig } from './types.js';
import { sha256 } from './canonical.js';
import { join } from 'node:path';

export interface ComposeRender {
  readonly yaml: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly services: readonly string[];
  readonly profiles: readonly string[];
  readonly oneShotServices: readonly string[];
}

export function renderCompose(config: SeedbedConfig): ComposeRender {
  if (config.compose.profiles.includes('ollama')) {
    throw new TypeError('Local Ollama requires an immutable model artifact selector and digest and is unavailable in this Seedbed candidate');
  }
  const services = ['workshop'];
  const extra: string[] = [];
  if (config.compose.profiles.includes('qdrant')) {
    services.push('qdrant');
    extra.push(`  qdrant:
    image: \${QDRANT_IMAGE}
    profiles: ["qdrant"]
    restart: unless-stopped
    read_only: true
    cap_drop: ["ALL"]
    security_opt: ["no-new-privileges:true"]
    environment:
      QDRANT__STORAGE__SNAPSHOTS_PATH: /qdrant/storage/snapshots
      QDRANT__TELEMETRY_DISABLED: "true"
    volumes:
      - qdrant-data:/qdrant/storage
    networks: [gnolith]
    healthcheck:
      test: ["CMD", "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/6333"]
      interval: 10s
      timeout: 3s
      retries: 12
    deploy:
      resources:
        limits: { cpus: "2.0", memory: 2G }`);
  }
  const portBindings = [`127.0.0.1:\${WORKSHOP_PORT}:4317`];
  if (config.compose.publishIpv6Loopback) portBindings.push(`[::1]:\${WORKSHOP_PORT}:4317`);
  const waystoneMount = config.compose.profiles.includes('waystone')
    ? '\n      - type: bind\n        source: ${WAYSTONE_ASSET_DIRECTORY}\n        target: /srv/waystone\n        read_only: true'
    : '';
  const semanticSecrets = (config.semantic?.credentialSelectors ?? [])
    .map((selector) => {
      const suffix = sha256(selector.id).slice(0, 16);
      return {
        id: selector.id,
        composeName: `gnolith-semantic-${suffix}`,
        target: `gnolith-semantic-${suffix}`,
        environment: `GNOLITH_SEMANTIC_${suffix.toUpperCase()}_FILE`,
        path: selector.path,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const workshopSecrets = [
    '      - gnolith-bearer',
    ...semanticSecrets.map((entry) => `      - source: ${entry.composeName}\n        target: ${entry.target}`),
  ].join('\n');
  const operatorSecrets = semanticSecrets.length === 0
    ? ''
    : `\n    secrets:\n${semanticSecrets.map((entry) => `      - source: ${entry.composeName}\n        target: ${entry.target}`).join('\n')}`;
  const volumes = [
    '  application-data:\n    name: ${APPLICATION_DATA_VOLUME}',
    ...(config.compose.profiles.includes('qdrant') ? ['  qdrant-data:\n    name: ${QDRANT_DATA_VOLUME}'] : []),
  ];
  const yaml = `name: \${COMPOSE_PROJECT_NAME}
services:
  workshop:
    image: \${COMPOSE_PROJECT_NAME}-workshop:local
    build:
      context: ./build
      dockerfile: docker/local-build.Dockerfile
      args:
        NODE_IMAGE: \${NODE_IMAGE}
        DIAMOND_ARTIFACT: \${DIAMOND_ARTIFACT}
        DIAMOND_SHA256: \${DIAMOND_SHA256}
        TAPROOT_ARTIFACT: \${TAPROOT_ARTIFACT}
        TAPROOT_SHA256: \${TAPROOT_SHA256}
        WORKSHOP_ARTIFACT: \${WORKSHOP_ARTIFACT}
        WORKSHOP_SHA256: \${WORKSHOP_SHA256}
    command: ["serve", "--config", "/app/seedbed/workshop.config.json"]
    restart: unless-stopped
    read_only: true
    user: "10001:10001"
    cap_drop: ["ALL"]
    security_opt: ["no-new-privileges:true"]
    tmpfs: ["/tmp:rw,noexec,nosuid,size=64m"]
    ports: [${portBindings.map((entry) => `"${entry}"`).join(', ')}]
    volumes:
      - application-data:/var/lib/gnolith${waystoneMount}
    secrets:
${workshopSecrets}
    networks: [gnolith]
    healthcheck:
      test: ["CMD", "node", "-e", "const t=require('fs').readFileSync('/run/secrets/gnolith-bearer','utf8').trim();fetch('http://127.0.0.1:4317/health/ready',{headers:{authorization:'Bearer '+t}}).then(function(r){if(!r.ok)process.exit(1)}).catch(function(){process.exit(1)})"]
      interval: 10s
      timeout: 3s
      retries: 12
    deploy:
      resources:
        limits: { cpus: "2.0", memory: 2G }
  seedbed-operator:
    image: \${COMPOSE_PROJECT_NAME}-workshop:local
    profiles: ["seedbed-operator"]
    entrypoint: ["node", "/app/seedbed/operator-runner.mjs"]
    restart: "no"
    read_only: true
    user: "10001:10001"
    cap_drop: ["ALL"]
    security_opt: ["no-new-privileges:true"]
    tmpfs: ["/tmp:rw,noexec,nosuid,size=64m"]
    volumes:
      - application-data:/var/lib/gnolith${operatorSecrets}
    networks: [gnolith]
    deploy:
      resources:
        limits: { cpus: "2.0", memory: 2G }
${extra.join('\n')}
networks:
  gnolith:
    name: \${GNOLITH_NETWORK_NAME}
    internal: false
volumes:
${volumes.join('\n')}
secrets:
  gnolith-bearer:
    file: \${GNOLITH_BEARER_FILE}
${semanticSecrets.map((entry) => `  ${entry.composeName}:\n    file: \${${entry.environment}}`).join('\n')}
`;
  const environment = {
    COMPOSE_PROJECT_NAME: config.compose.projectName,
    WORKSHOP_PORT: String(config.compose.workshopPort),
    NODE_IMAGE: config.compose.nodeImage,
    DIAMOND_ARTIFACT: config.packages.diamond.artifact,
    DIAMOND_SHA256: config.packages.diamond.sha256,
    TAPROOT_ARTIFACT: config.packages.taproot.artifact,
    TAPROOT_SHA256: config.packages.taproot.sha256,
    WORKSHOP_ARTIFACT: config.packages.workshop.artifact,
    WORKSHOP_SHA256: config.packages.workshop.sha256,
    GNOLITH_BEARER_FILE: config.authentication.tokenFile,
    GNOLITH_NETWORK_NAME: config.compose.networkName,
    APPLICATION_DATA_VOLUME: config.compose.dataVolume,
    ...(config.compose.profiles.includes('waystone') ? {
      WAYSTONE_ASSET_DIRECTORY: join(config.paths.stateDirectory, 'compose', 'waystone'),
    } : {}),
    ...(config.compose.profiles.includes('qdrant') ? { QDRANT_DATA_VOLUME: config.compose.qdrantVolume! } : {}),
    ...(config.compose.qdrantImage === undefined ? {} : { QDRANT_IMAGE: config.compose.qdrantImage }),
    ...Object.fromEntries(semanticSecrets.map((entry) => [entry.environment, entry.path])),
  };
  return { yaml, environment, services, profiles: [...config.compose.profiles], oneShotServices: ['seedbed-operator'] };
}

export function assertSafeComposeEnvironment(environment: Readonly<Record<string, string>>): void {
  const forbidden = /(?:TOKEN|PASSWORD|SECRET|API_KEY)$/u;
  for (const [key, value] of Object.entries(environment)) {
    if (forbidden.test(key) && key !== 'GNOLITH_BEARER_FILE') throw new TypeError(`Compose environment contains forbidden secret literal ${key}`);
    if (value.includes('\n') || value.includes('\r') || value.includes('\0')) throw new TypeError(`Compose environment ${key} contains control characters`);
  }
}

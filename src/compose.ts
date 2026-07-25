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
    networks:
      gnolith:
        aliases: [qdrant]
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
  if (
    config.compose.profiles.includes('qdrant')
    && config.semantic?.configuration.vector.kind === 'qdrant'
  ) {
    const vector = config.semantic?.configuration.vector;
    services.push('qdrant-init');
    const credential = vector.credentialSelector === null
      ? undefined
      : semanticSecrets.find((entry) => entry.id === vector.credentialSelector);
    if (vector.credentialSelector !== null && credential === undefined) {
      throw new TypeError('The Qdrant Compose profile credential selector is unavailable');
    }
    extra.push(`  qdrant-init:
    image: \${NODE_IMAGE}
    profiles: ["qdrant"]
    command:
      - node
      - -e
      - |
        const fs=require('node:fs');const h={'content-type':'application/json'};if(process.env.QDRANT_API_KEY_FILE){const v=fs.readFileSync(process.env.QDRANT_API_KEY_FILE,'utf8').replace(/\\r?\\n$/u,'');if(!v||/^\\s|\\s$|[\\u0000-\\u001f\\u007f]/u.test(v))throw new Error('invalid Qdrant credential');h['api-key']=v}const u='http://qdrant:6333/collections/'+encodeURIComponent(process.env.QDRANT_COLLECTION);const size=Number(process.env.QDRANT_DIMENSIONS);const distance=process.env.QDRANT_DISTANCE;const check=async()=>{const r=await fetch(u,{headers:h,redirect:'error'});if(!r.ok)throw new Error('Qdrant collection verification failed');const b=await r.json();const v=b?.result?.config?.params?.vectors;if(Number(v?.size)!==size||String(v?.distance??'').toLowerCase()!==distance.toLowerCase())throw new Error('Qdrant collection contract mismatch')};(async()=>{const r=await fetch(u,{headers:h,redirect:'error'});if(r.status===404){const created=await fetch(u,{method:'PUT',headers:h,redirect:'error',body:JSON.stringify({vectors:{size,distance}})});if(!created.ok)throw new Error('Qdrant collection creation failed')}else if(!r.ok)throw new Error('Qdrant collection lookup failed');await check()})().then(()=>process.exit(0),()=>process.exit(1))
    restart: "no"
    read_only: true
    user: "10001:10001"
    cap_drop: ["ALL"]
    security_opt: ["no-new-privileges:true"]
    tmpfs: ["/tmp:rw,noexec,nosuid,size=16m"]
    environment:
      QDRANT_COLLECTION: \${QDRANT_COLLECTION}
      QDRANT_DIMENSIONS: \${QDRANT_DIMENSIONS}
      QDRANT_DISTANCE: \${QDRANT_DISTANCE}${credential === undefined ? '' : `\n      QDRANT_API_KEY_FILE: /run/secrets/${credential.target}`}
    networks: [gnolith]
    depends_on:
      qdrant:
        condition: service_healthy${credential === undefined ? '' : '\n    volumes:\n      - protected-credentials:/run/secrets:ro'}
    deploy:
      resources:
        limits: { cpus: "0.5", memory: 128M }`);
  }
  const usesHostGateway = config.semantic !== undefined && (
    new URL(config.semantic.configuration.provider.endpoint).hostname === 'host.docker.internal'
    || (
      config.semantic.configuration.vector.kind === 'qdrant'
      && new URL(config.semantic.configuration.vector.endpoint).hostname === 'host.docker.internal'
    )
  );
  const hostGateway = usesHostGateway
    ? '\n    extra_hosts: ["host.docker.internal:host-gateway"]'
    : '';
  const qdrantDependency = config.compose.profiles.includes('qdrant')
    && config.semantic?.configuration.vector.kind === 'qdrant'
    ? '\n    depends_on:\n      qdrant-init:\n        condition: service_completed_successfully'
    : '';
  const volumes = [
    '  application-data:\n    name: ${APPLICATION_DATA_VOLUME}',
    '  protected-credentials:\n    name: ${PROTECTED_CREDENTIAL_VOLUME}\n    external: true',
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
    restart: "no"
    read_only: true
    user: "10001:10001"
    cap_drop: ["ALL"]
    security_opt: ["no-new-privileges:true"]
    tmpfs: ["/tmp:rw,noexec,nosuid,size=64m"]
    ports: [${portBindings.map((entry) => `"${entry}"`).join(', ')}]
    volumes:
      - application-data:/var/lib/gnolith
      - protected-credentials:/run/secrets:ro${waystoneMount}
    networks: [gnolith]${hostGateway}${qdrantDependency}
    healthcheck:
      test: ["CMD", "node", "-e", "let t=require('fs').readFileSync('/run/secrets/gnolith-bearer','utf8');if(Buffer.byteLength(t)!==43&&Buffer.byteLength(t)!==44)process.exit(1);t=t.endsWith('\\\\n')?t.slice(0,-1):t;if(!/^[A-Za-z0-9_-]{43}$/u.test(t))process.exit(1);fetch('http://127.0.0.1:4317/health/live',{headers:{authorization:'Bearer '+t}}).then(function(r){if(!r.ok)process.exit(1)}).catch(function(){process.exit(1)})"]
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
      - application-data:/var/lib/gnolith
    networks: [gnolith]${hostGateway}
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
    GNOLITH_NETWORK_NAME: config.compose.networkName,
    APPLICATION_DATA_VOLUME: config.compose.dataVolume,
    PROTECTED_CREDENTIAL_VOLUME: `${config.compose.projectName}-protected-credentials`,
    ...(config.compose.profiles.includes('waystone') ? {
      WAYSTONE_ASSET_DIRECTORY: join(config.paths.stateDirectory, 'compose', 'waystone'),
    } : {}),
    ...(config.compose.profiles.includes('qdrant') ? { QDRANT_DATA_VOLUME: config.compose.qdrantVolume! } : {}),
    ...(config.semantic?.configuration.vector.kind === 'qdrant' ? {
      QDRANT_COLLECTION: config.semantic.configuration.vector.collection,
      QDRANT_DIMENSIONS: String(config.semantic.configuration.provider.dimensions),
      QDRANT_DISTANCE: config.semantic.configuration.provider.metric === 'cosine'
        ? 'Cosine'
        : config.semantic.configuration.provider.metric === 'dot'
          ? 'Dot'
          : 'Euclid',
    } : {}),
    ...(config.compose.qdrantImage === undefined ? {} : { QDRANT_IMAGE: config.compose.qdrantImage }),
  };
  return {
    yaml,
    environment,
    services,
    profiles: [...config.compose.profiles],
    oneShotServices: [
      'seedbed-operator',
      ...(
        config.compose.profiles.includes('qdrant')
        && config.semantic?.configuration.vector.kind === 'qdrant'
          ? ['qdrant-init']
          : []
      ),
    ],
  };
}

export function assertSafeComposeEnvironment(environment: Readonly<Record<string, string>>): void {
  const forbidden = /(?:TOKEN|PASSWORD|SECRET|API_KEY)$/u;
  for (const [key, value] of Object.entries(environment)) {
    if (forbidden.test(key)) throw new TypeError(`Compose environment contains forbidden secret literal ${key}`);
    if (value.includes('\n') || value.includes('\r') || value.includes('\0')) throw new TypeError(`Compose environment ${key} contains control characters`);
  }
}

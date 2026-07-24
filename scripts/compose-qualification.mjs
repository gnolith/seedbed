import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

const document = YAML.parse(await readFile('compose/compose.yaml', 'utf8'));
const services = Object.keys(document.services).sort();
if (JSON.stringify(services) !== JSON.stringify(['qdrant', 'seedbed-operator', 'workshop'])) throw new Error(`unexpected Compose services: ${services.join(',')}`);
if (document.services.workshop.image.includes('ghcr.io')) throw new Error('Workshop must be built locally');
if (document.services.workshop.command.join(' ') !== 'serve --config /app/seedbed/workshop.config.json') throw new Error('Workshop must use its exact config-only serve CLI');
if (!document.services.workshop.healthcheck.test.join(' ').includes('/health/ready')) throw new Error('Workshop healthcheck must use exact readiness');
if (!document.services.workshop.ports.every((entry) => String(entry).startsWith('127.0.0.1:'))) throw new Error('default ports must bind host IPv4 loopback');
if (document.services.qdrant.ports) throw new Error('optional services must not publish ports');
if (!document.services['seedbed-operator'].profiles?.includes('seedbed-operator') || document.services['seedbed-operator'].ports) throw new Error('one-shot operator must remain profile-gated and unpublished');
for (const service of Object.values(document.services)) {
  if (service.read_only !== true || !service.cap_drop?.includes('ALL') || !service.security_opt?.includes('no-new-privileges:true')) throw new Error('service hardening is incomplete');
}
if (process.platform !== 'win32') {
  execFileSync('docker', ['compose', '--file', 'compose/compose.yaml', 'config', '--quiet'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      COMPOSE_PROJECT_NAME: 'gnolith-candidate',
      WORKSHOP_PORT: '4317',
      NODE_IMAGE: `node@sha256:${'d'.repeat(64)}`,
      DIAMOND_ARTIFACT: 'artifacts/diamond.tgz',
      DIAMOND_SHA256: 'a'.repeat(64),
      TAPROOT_ARTIFACT: 'artifacts/taproot.tgz',
      TAPROOT_SHA256: 'b'.repeat(64),
      WORKSHOP_ARTIFACT: 'artifacts/workshop.tgz',
      WORKSHOP_SHA256: 'c'.repeat(64),
      GNOLITH_BEARER_FILE: '/tmp/gnolith-bearer',
      GNOLITH_NETWORK_NAME: 'gnolith-candidate',
      APPLICATION_DATA_VOLUME: 'gnolith-candidate-data',
      QDRANT_DATA_VOLUME: 'gnolith-candidate-qdrant',
      WAYSTONE_ASSET_DIRECTORY: '/tmp/gnolith-waystone',
      QDRANT_IMAGE: `qdrant/qdrant@sha256:${'1'.repeat(64)}`,
    },
  });
}
console.log(`verified Compose graph (${services.join(', ')})`);

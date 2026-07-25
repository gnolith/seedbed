import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createCandidateSbom } from './candidate-sbom.mjs';
import { loadWaystoneEvidence } from './waystone-evidence.mjs';

const packageManifest = JSON.parse(await readFile('package.json', 'utf8'));
const componentLock = JSON.parse(await readFile('seedbed-component-lock.json', 'utf8'));
const waystoneManifest = JSON.parse(await readFile(componentLock.packages.waystone.artifact, 'utf8'));
const shippedArchives = {};
for (const name of ['diamond', 'taproot', 'workshop', 'waystone']) {
  const path = name === 'waystone'
    ? `components/gnolith-waystone-${componentLock.packages.waystone.version}.tgz`
    : componentLock.packages[name].artifact;
  shippedArchives[name] = {
    path,
    sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
  };
}
const waystoneEvidence = await loadWaystoneEvidence(componentLock, shippedArchives, waystoneManifest);
const input = {
  packageManifest,
  componentLock,
  waystoneManifest,
  waystoneEvidence,
  shippedArchives,
  commit: '1'.repeat(40),
  tree: '2'.repeat(40),
  commitTimestamp: '2026-01-01T00:00:00Z',
  packageSha256: '3'.repeat(64),
  composeBundleSha256: '4'.repeat(64),
  graphSha256: '5'.repeat(64),
  componentLockSha256: '6'.repeat(64),
};
const first = createCandidateSbom(input);
const second = createCandidateSbom(input);
if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('candidate SBOM is not deterministic');
if (first.components.length !== 12 || first.dependencies.length !== 13) {
  throw new Error('candidate SBOM composition/dependency inventory is incomplete');
}
for (const name of ['diamond', 'taproot', 'workshop', 'waystone']) {
  const component = first.components.find((entry) => entry.name === name);
  if (!component?.purl || !component.hashes?.length || !component.licenses?.length) {
    throw new Error(`candidate SBOM component evidence is incomplete for ${name}`);
  }
}
console.log('verified deterministic complete CycloneDX candidate composition');

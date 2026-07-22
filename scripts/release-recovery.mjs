import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReleaseEvidence } from './release-preflight.mjs';

const plan = Object.freeze({
  tag: 'v0.2.2',
  commit: '74737bec42368df4f006adcac5fe215edc732094',
  version: '0.2.2',
  runId: '29915140208',
  workflowId: '317536422',
  workflowBlob: 'a1ab8cbb6a0e13c1e0e7a1e029f5989b18f7eaaa',
  npmSha256: '2bf53198f07493490a205d28ade3586d26d0a6a02c85434d6e2d5ebe90be423b',
  npmIntegrity: 'sha512-nyMdjkJJjSLXlppljaR4J37R8vQZtXO8KxohJYhwAjenniEA3Ix9q0mssrTGM4jnBSZVQTIAHEkMa37DJp/Cvg==',
  closureSha256: 'd565ac3ac011a0b2bb860486927365befe5823f19c5ad9b0a2592f9093c7f739',
  imageDigest: 'sha256:f1a05b0e43ee76c3ce0a8ef5806ade7a5b64603b25f5fca021a47ff3ac44b389',
  imageSbomSha256: '806745ac5cae12ec177d4814958cbed2d69d967d1c020fe666414b0a18284070',
  imageManifestSha256: 'f1a05b0e43ee76c3ce0a8ef5806ade7a5b64603b25f5fca021a47ff3ac44b389',
  provenanceEvidenceSha256: '9e21452a11081d08a5179a72c6b11c4053a40bf8bb895635de7a6d2b9c0fb97e',
  releaseEvidenceSha256: '82d8695159ee293b10634f7c64942600e39c899dac4bfccd58f0b9e8f71d79f8',
  jobs: [
    { id: '88907134527', name: 'package', conclusion: 'success' },
    { id: '88907578374', name: 'publish', conclusion: 'success' },
    { id: '88907767057', name: 'image', conclusion: 'success' },
    { id: '88908286874', name: 'release', conclusion: 'failure' },
  ],
  artifacts: [
    { id: '8527551634', name: 'seedbed-npm-2bf53198f07493490a205d28ade3586d26d0a6a02c85434d6e2d5ebe90be423b-attempt-1', digest: 'sha256:cf42118f42f6c28dbf0658ea5bfd8e2679f95b8665696aba8f51625d32e4172b', size: 241636, expiresAt: '2026-08-21T11:18:08Z', directory: 'npm' },
    { id: '8527589468', name: 'seedbed-staging-2bf53198f07493490a205d28ade3586d26d0a6a02c85434d6e2d5ebe90be423b-attempt-1', digest: 'sha256:ba151b367f9562f575dddd59a140cccda70698f19fdad31c432cc7aad87e0f6a', size: 14210303, expiresAt: '2026-08-21T11:19:39Z', directory: 'staging' },
    { id: '8527678405', name: 'seedbed-image-evidence-sha256-f1a05b0e43ee76c3ce0a8ef5806ade7a5b64603b25f5fca021a47ff3ac44b389-attempt-1', digest: 'sha256:dfbf2b6438b33d877f3d90fbb9e6d26dd370d1574e8ecf0fafd37a3eacd9dc53', size: 6656391, expiresAt: '2026-08-21T11:23:09Z', directory: 'image' },
  ],
  inventory: [
    { path: 'image/image-manifest.json', bytes: 856, sha256: 'f1a05b0e43ee76c3ce0a8ef5806ade7a5b64603b25f5fca021a47ff3ac44b389' },
    { path: 'image/image-provenance-verification.json', bytes: 423, sha256: '9e21452a11081d08a5179a72c6b11c4053a40bf8bb895635de7a6d2b9c0fb97e' },
    { path: 'image/image-sbom.json', bytes: 6654678, sha256: '806745ac5cae12ec177d4814958cbed2d69d967d1c020fe666414b0a18284070' },
    { path: 'npm/seedbed-publication-2bf53198f07493490a205d28ade3586d26d0a6a02c85434d6e2d5ebe90be423b.tgz', bytes: 240982, sha256: '2bf53198f07493490a205d28ade3586d26d0a6a02c85434d6e2d5ebe90be423b' },
    { path: 'npm/seedbed-publication.json', bytes: 224, sha256: '462db1b0573119e0326498db33c6a8ee1cf0d51425723957f43079403641cee5' },
    { path: 'staging/docs/mcp-runtime-sbom.json', bytes: 38207, sha256: '492322da93a4cd46f6057d1b9c6b36c59500967e65b10ffbf9c010c4439801f4' },
    { path: 'staging/gnolith-production-closure.tar.gz', bytes: 14171466, sha256: 'd565ac3ac011a0b2bb860486927365befe5823f19c5ad9b0a2592f9093c7f739' },
    { path: 'staging/gnolith-production-closure.tar.gz.sha256', bytes: 134, sha256: 'ce86aeff089da94fe3dbc19e9f838d379f515dbcf7fb1d798cdcbdb1a7de851d' },
  ],
});

const releaseCopies = Object.freeze([
  ['npm/seedbed-publication-2bf53198f07493490a205d28ade3586d26d0a6a02c85434d6e2d5ebe90be423b.tgz', 'seedbed-publication-2bf53198f07493490a205d28ade3586d26d0a6a02c85434d6e2d5ebe90be423b.tgz'],
  ['staging/gnolith-production-closure.tar.gz', 'seedbed-production-closure-d565ac3ac011a0b2bb860486927365befe5823f19c5ad9b0a2592f9093c7f739.tar.gz'],
  ['staging/docs/mcp-runtime-sbom.json', 'seedbed-mcp-runtime-sbom-492322da93a4cd46f6057d1b9c6b36c59500967e65b10ffbf9c010c4439801f4.json'],
  ['image/image-sbom.json', 'seedbed-image-sbom-806745ac5cae12ec177d4814958cbed2d69d967d1c020fe666414b0a18284070.json'],
  ['image/image-manifest.json', 'seedbed-image-manifest-f1a05b0e43ee76c3ce0a8ef5806ade7a5b64603b25f5fca021a47ff3ac44b389.json'],
  ['image/image-provenance-verification.json', 'seedbed-image-provenance-verification-9e21452a11081d08a5179a72c6b11c4053a40bf8bb895635de7a6d2b9c0fb97e.json'],
]);

export function getV022RecoveryPlan(tag) {
  if (tag !== plan.tag) throw new Error(`unsupported release recovery tag: ${tag}`);
  return plan;
}

export function validateV022RecoveryInventory(tag, inventory) {
  getV022RecoveryPlan(tag);
  const normalized = [...inventory].sort((left, right) => left.path.localeCompare(right.path));
  const expected = [...plan.inventory].sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
    throw new Error('retained release artifact inventory does not match the frozen v0.2.2 evidence');
  }
  return normalized;
}

async function inventoryDirectory(root) {
  const entries = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        entries.push({
          path: relative(root, absolute).split(sep).join('/'),
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      } else throw new Error(`unsupported retained artifact entry: ${absolute}`);
    }
  }
  await visit(root);
  return entries;
}

async function stageRecoveryAssets(tag, root, destination) {
  validateV022RecoveryInventory(tag, await inventoryDirectory(root));
  await mkdir(destination, { recursive: false });
  for (const [source, name] of releaseCopies) await copyFile(join(root, source), join(destination, name));
  const evidence = createReleaseEvidence({
    releaseTag: plan.tag,
    releaseCommit: plan.commit,
    seedbedVersion: plan.version,
    npmSha256: plan.npmSha256,
    npmIntegrity: plan.npmIntegrity,
    closureSha256: plan.closureSha256,
    imageDigest: plan.imageDigest,
    imageSbomSha256: plan.imageSbomSha256,
    imageManifestSha256: plan.imageManifestSha256,
    provenanceEvidenceSha256: plan.provenanceEvidenceSha256,
    immutableSettingEvidenceTag: plan.tag,
  });
  const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
  const evidenceSha = createHash('sha256').update(evidenceBytes).digest('hex');
  if (evidenceSha !== plan.releaseEvidenceSha256) throw new Error('release evidence identity drifted');
  const evidenceName = `seedbed-release-evidence-${evidenceSha}.json`;
  await writeFile(join(destination, evidenceName), evidenceBytes);
  const names = [...releaseCopies.map(([, name]) => name), evidenceName].sort();
  await writeFile(join(dirname(destination), 'expected-release-assets.txt'), `${names.join('\n')}\n`);
  return names;
}

function writeOutputs() {
  const output = {
    commit: plan.commit,
    version: plan.version,
    run_id: plan.runId,
    npm_sha256: plan.npmSha256,
    npm_integrity: plan.npmIntegrity,
    closure_sha256: plan.closureSha256,
    image_digest: plan.imageDigest,
  };
  process.stdout.write(Object.entries(output).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, tag, first, second] = process.argv.slice(2);
  if (command === 'plan') process.stdout.write(`${JSON.stringify(getV022RecoveryPlan(tag), null, 2)}\n`);
  else if (command === 'github-output') { getV022RecoveryPlan(tag); writeOutputs(); }
  else if (command === 'verify-inventory') {
    validateV022RecoveryInventory(tag, await inventoryDirectory(first));
    process.stdout.write('retained v0.2.2 artifact inventory verified\n');
  } else if (command === 'stage') {
    const names = await stageRecoveryAssets(tag, first, second);
    process.stdout.write(`${JSON.stringify(names)}\n`);
  } else throw new Error('usage: release-recovery <plan|github-output|verify-inventory|stage> v0.2.2 [source] [destination]');
}

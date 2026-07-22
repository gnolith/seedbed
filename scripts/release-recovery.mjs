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
  npmShasum: 'b709b6ea24aecf7f96dd8286d4d07e9bfc727d7b',
  npmTarballUrl: 'https://registry.npmjs.org/@gnolith/seedbed/-/seedbed-0.2.2.tgz',
  npmFileCount: 59,
  npmUnpackedSize: 1249898,
  npmSignatureKeyId: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U',
  npmSignature: 'MEYCIQCb/sNAVE6XdjiyBC5GTO6sTkJ66auA8kCJwol/0NqywAIhAJqWGufSBFqUHk75P9Qsg1qZvm9o6NNzPKKhNzggpDav',
  closureSha256: 'd565ac3ac011a0b2bb860486927365befe5823f19c5ad9b0a2592f9093c7f739',
  imageDigest: 'sha256:f1a05b0e43ee76c3ce0a8ef5806ade7a5b64603b25f5fca021a47ff3ac44b389',
  imageSbomSha256: '806745ac5cae12ec177d4814958cbed2d69d967d1c020fe666414b0a18284070',
  imageManifestSha256: 'f1a05b0e43ee76c3ce0a8ef5806ade7a5b64603b25f5fca021a47ff3ac44b389',
  provenanceEvidenceSha256: '9e21452a11081d08a5179a72c6b11c4053a40bf8bb895635de7a6d2b9c0fb97e',
  releaseEvidenceSha256: '82d8695159ee293b10634f7c64942600e39c899dac4bfccd58f0b9e8f71d79f8',
  npmAttestationsUrl: 'https://registry.npmjs.org/-/npm/v1/attestations/@gnolith%2fseedbed@0.2.2',
  priorLatestReleaseTag: 'v0.1.1',
  repositoryId: '1307629856',
  repositoryOwnerId: '307278281',
  builderId: 'https://github.com/actions/runner/github-hosted',
  invocationId: 'https://github.com/gnolith/seedbed/actions/runs/29915140208/attempts/1',
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

export function getV022ReleaseAssetNames(tag) {
  getV022RecoveryPlan(tag);
  return [
    ...releaseCopies.map(([, name]) => name),
    `seedbed-release-evidence-${plan.releaseEvidenceSha256}.json`,
  ].sort();
}

export function getV022ReleaseCopies(tag) {
  getV022RecoveryPlan(tag);
  return releaseCopies.map(([source, name]) => [source, name]);
}

export function validateV022NpmMetadata(tag, metadata) {
  getV022RecoveryPlan(tag);
  if (metadata?.name !== '@gnolith/seedbed' || metadata?.version !== plan.version ||
      metadata?.dist?.integrity !== plan.npmIntegrity ||
      metadata?.dist?.shasum !== plan.npmShasum || metadata?.dist?.tarball !== plan.npmTarballUrl ||
      metadata?.dist?.fileCount !== plan.npmFileCount || metadata?.dist?.unpackedSize !== plan.npmUnpackedSize ||
      metadata?.dist?.attestations?.url !== plan.npmAttestationsUrl ||
      metadata?.dist?.attestations?.provenance?.predicateType !== 'https://slsa.dev/provenance/v1' ||
      metadata?.dist?.signatures?.length !== 1 ||
      metadata.dist.signatures[0]?.keyid !== plan.npmSignatureKeyId ||
      metadata.dist.signatures[0]?.sig !== plan.npmSignature) {
    throw new Error('published npm metadata does not match frozen v0.2.2 identity');
  }
}

export function validateV022NpmProvenance(tag, response) {
  getV022RecoveryPlan(tag);
  const attestations = response?.attestations?.filter(
    ({ predicateType }) => predicateType === 'https://slsa.dev/provenance/v1',
  ) ?? [];
  if (attestations.length !== 1) throw new Error('expected exactly one SLSA v1 provenance attestation');
  const envelope = attestations[0]?.bundle?.dsseEnvelope;
  const bundle = attestations[0]?.bundle;
  const signature = envelope?.signatures?.[0];
  const verification = bundle?.verificationMaterial;
  if (bundle?.mediaType !== 'application/vnd.dev.sigstore.bundle.v0.3+json' ||
      envelope?.payloadType !== 'application/vnd.in-toto+json' || typeof envelope.payload !== 'string' ||
      envelope.signatures?.length !== 1 || signature?.keyid !== '' || !isCanonicalBase64(signature?.sig) ||
      !isCanonicalBase64(verification?.certificate?.rawBytes) || verification?.tlogEntries?.length !== 1 ||
      verification.tlogEntries[0]?.kindVersion?.kind !== 'dsse' ||
      verification.tlogEntries[0]?.kindVersion?.version !== '0.0.1') {
    throw new Error('unexpected npm provenance DSSE envelope');
  }
  const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  const expectedSha512 = Buffer.from(plan.npmIntegrity.slice('sha512-'.length), 'base64').toString('hex');
  if (statement?._type !== 'https://in-toto.io/Statement/v1' ||
      statement?.predicateType !== 'https://slsa.dev/provenance/v1' ||
      statement?.subject?.length !== 1 ||
      statement.subject[0]?.name !== `pkg:npm/%40gnolith/seedbed@${plan.version}` ||
      statement.subject[0]?.digest?.sha512 !== expectedSha512) {
    throw new Error('unexpected npm provenance statement or subject');
  }
  const build = statement.predicate?.buildDefinition;
  if (build?.buildType !== 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1') {
    throw new Error('unexpected npm provenance build type');
  }
  const workflow = build.externalParameters?.workflow;
  if (workflow?.repository !== 'https://github.com/gnolith/seedbed' ||
      workflow?.path !== '.github/workflows/release.yml' || workflow?.ref !== `refs/tags/${plan.tag}`) {
    throw new Error('unexpected npm provenance workflow');
  }
  const source = build.resolvedDependencies?.filter(
    ({ uri }) => uri === `git+https://github.com/gnolith/seedbed@refs/tags/${plan.tag}`,
  ) ?? [];
  if (source.length !== 1 || source[0]?.digest?.gitCommit !== plan.commit) {
    throw new Error('unexpected npm provenance source commit');
  }
  const github = build.internalParameters?.github;
  if (github?.event_name !== 'push' || github?.repository_id !== plan.repositoryId ||
      github?.repository_owner_id !== plan.repositoryOwnerId ||
      statement.predicate?.runDetails?.builder?.id !== plan.builderId ||
      statement.predicate?.runDetails?.metadata?.invocationId !== plan.invocationId) {
    throw new Error('unexpected npm provenance invocation identity');
  }
}

function isCanonicalBase64(value) {
  return typeof value === 'string' && value.length > 0 && value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/u.test(value) && Buffer.from(value, 'base64').toString('base64') === value;
}

export function decideV022ReleaseRecovery(tag, firstState, secondState, draftCount, latestTag) {
  getV022RecoveryPlan(tag);
  if (draftCount !== 0) throw new Error('a draft v0.2.2 Release exists');
  if (firstState === 'absent') {
    if (secondState !== 'absent') throw new Error('Release state changed during the recovery preflight');
    if (latestTag !== plan.priorLatestReleaseTag) throw new Error('unexpected prior latest GitHub Release');
    return 'create';
  }
  if (firstState === 'match') {
    if (secondState !== 'not-checked' || latestTag !== plan.tag) {
      throw new Error('existing immutable v0.2.2 Release is not the exact latest state');
    }
    return 'verify';
  }
  throw new Error('GitHub Release recovery found draft, mutable, partial, or conflicting state');
}

export function validateV022ReleaseSnapshot(tag, release) {
  getV022RecoveryPlan(tag);
  if (release?.tag_name !== plan.tag || release?.name !== 'Seedbed 0.2.2' || release?.body !== 'Seedbed 0.2.2' ||
      release?.draft !== false || release?.prerelease !== false || release?.immutable !== true) {
    throw new Error('GitHub Release metadata does not match frozen v0.2.2 identity');
  }
  const expectedSizes = new Map([
    [`seedbed-publication-${plan.npmSha256}.tgz`, 240982],
    [`seedbed-production-closure-${plan.closureSha256}.tar.gz`, 14171466],
    ['seedbed-mcp-runtime-sbom-492322da93a4cd46f6057d1b9c6b36c59500967e65b10ffbf9c010c4439801f4.json', 38207],
    [`seedbed-image-sbom-${plan.imageSbomSha256}.json`, 6654678],
    [`seedbed-image-manifest-${plan.imageManifestSha256}.json`, 856],
    [`seedbed-image-provenance-verification-${plan.provenanceEvidenceSha256}.json`, 423],
    [`seedbed-release-evidence-${plan.releaseEvidenceSha256}.json`, 1250],
  ]);
  if (!Array.isArray(release.assets) || release.assets.length !== expectedSizes.size) {
    throw new Error('GitHub Release asset count does not match frozen v0.2.2 identity');
  }
  const seen = new Set();
  for (const asset of release.assets) {
    const expectedSize = expectedSizes.get(asset?.name);
    const digest = asset?.name?.match(/-([a-f0-9]{64})\.(?:json|tgz|tar\.gz)$/)?.[1];
    if (expectedSize === undefined || seen.has(asset.name) || asset.state !== 'uploaded' ||
        asset.size !== expectedSize || asset.digest !== `sha256:${digest}`) {
      throw new Error('GitHub Release asset identity does not match frozen v0.2.2 evidence');
    }
    seen.add(asset.name);
  }
}

export function countV022DraftReleases(tag, pages) {
  getV022RecoveryPlan(tag);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error('paginated GitHub Releases response is malformed');
  }
  return pages.flat().filter((release) => release?.tag_name === plan.tag && release?.draft === true).length;
}

export async function fetchV022DraftCount(tag, apiUrl, token, fetchImpl = fetch) {
  getV022RecoveryPlan(tag);
  if (apiUrl !== 'https://api.github.com/repos/gnolith/seedbed/releases' || !token) {
    throw new Error('invalid authenticated GitHub Releases enumeration input');
  }
  let draftCount = 0;
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetchImpl(`${apiUrl}?per_page=100&page=${page}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub Releases enumeration failed with HTTP ${response.status}`);
    const releases = await response.json();
    if (!Array.isArray(releases) || releases.length > 100) {
      throw new Error('GitHub Releases enumeration returned malformed pagination');
    }
    draftCount += countV022DraftReleases(tag, [releases]);
    if (releases.length < 100) return draftCount;
  }
  throw new Error('GitHub Releases enumeration exceeded the bounded 1000-release audit window');
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

export async function stageRecoveryAssetsFromDefinition(definition, copies, root, destination) {
  const actual = (await inventoryDirectory(root)).sort((left, right) => left.path.localeCompare(right.path));
  const expected = [...definition.inventory].sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('release staging inventory mismatch');
  await mkdir(destination, { recursive: false });
  for (const [source, name] of copies) await copyFile(join(root, source), join(destination, name));
  const evidence = createReleaseEvidence({
    releaseTag: definition.tag,
    releaseCommit: definition.commit,
    seedbedVersion: definition.version,
    npmSha256: definition.npmSha256,
    npmIntegrity: definition.npmIntegrity,
    closureSha256: definition.closureSha256,
    imageDigest: definition.imageDigest,
    imageSbomSha256: definition.imageSbomSha256,
    imageManifestSha256: definition.imageManifestSha256,
    provenanceEvidenceSha256: definition.provenanceEvidenceSha256,
    immutableSettingEvidenceTag: definition.tag,
  });
  const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
  const evidenceSha = createHash('sha256').update(evidenceBytes).digest('hex');
  if (evidenceSha !== definition.releaseEvidenceSha256) throw new Error('release evidence identity drifted');
  const evidenceName = `seedbed-release-evidence-${evidenceSha}.json`;
  await writeFile(join(destination, evidenceName), evidenceBytes);
  const names = [...copies.map(([, name]) => name), evidenceName].sort();
  await writeFile(join(dirname(destination), 'expected-release-assets.txt'), `${names.join('\n')}\n`);
  return names;
}

export async function stageV022RecoveryAssets(tag, root, destination) {
  getV022RecoveryPlan(tag);
  return stageRecoveryAssetsFromDefinition(plan, releaseCopies, root, destination);
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
  else if (command === 'verify-npm-metadata') {
    validateV022NpmMetadata(tag, JSON.parse(await readFile(first, 'utf8')));
    process.stdout.write('published npm metadata verified\n');
  } else if (command === 'verify-npm-provenance') {
    validateV022NpmProvenance(tag, JSON.parse(await readFile(first, 'utf8')));
    process.stdout.write('published npm provenance verified\n');
  } else if (command === 'release-decision') {
    const [firstState, secondState, draftCount, latestTag] = process.argv.slice(4);
    process.stdout.write(`${decideV022ReleaseRecovery(tag, firstState, secondState, Number(draftCount), latestTag)}\n`);
  } else if (command === 'verify-release-json') {
    validateV022ReleaseSnapshot(tag, JSON.parse(await readFile(first, 'utf8')));
    process.stdout.write('immutable v0.2.2 GitHub Release snapshot verified\n');
  } else if (command === 'count-drafts') {
    process.stdout.write(`${countV022DraftReleases(tag, JSON.parse(await readFile(first, 'utf8')))}\n`);
  } else if (command === 'fetch-draft-count') {
    process.stdout.write(`${await fetchV022DraftCount(tag, first, process.env.GITHUB_TOKEN)}\n`);
  } else if (command === 'verify-inventory') {
    validateV022RecoveryInventory(tag, await inventoryDirectory(first));
    process.stdout.write('retained v0.2.2 artifact inventory verified\n');
  } else if (command === 'stage') {
    const names = await stageV022RecoveryAssets(tag, first, second);
    process.stdout.write(`${JSON.stringify(names)}\n`);
  } else throw new Error('usage: release-recovery <plan|github-output|verify-npm-metadata|verify-npm-provenance|release-decision|verify-release-json|count-drafts|fetch-draft-count|verify-inventory|stage> v0.2.2 [...]');
}

import { pathToFileURL } from 'node:url';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export async function requestJson(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      headers: options.headers,
      redirect: 'error',
      signal: controller.signal,
    });
    const text = await readBoundedText(response);
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new Error('remote preflight returned malformed JSON');
    }
    return { status: response.status, body };
  } catch (error) {
    if (error instanceof Error && /^remote preflight/u.test(error.message)) throw error;
    throw new Error(controller.signal.aborted ? 'remote preflight timed out' : 'remote preflight request failed');
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedText(response) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error('remote preflight response exceeded 1 MiB');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('remote preflight response exceeded 1 MiB');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

export function classifyNpmVersion(status, body, expected) {
  if (status === 404) return { state: 'absent' };
  if (status < 200 || status >= 300) throw new Error(`npm preflight failed closed with HTTP ${status}`);
  if (!body || body.name !== expected.name || body.version !== expected.version) throw new Error('npm preflight identity mismatch');
  if (body.dist?.integrity !== expected.integrity) throw new Error('npm preflight integrity mismatch');
  if (body.dist?.attestations?.provenance?.predicateType !== 'https://slsa.dev/provenance/v1') {
    throw new Error('npm preflight provenance is missing');
  }
  return { state: 'match' };
}

export function classifyGhcrVersions(status, body, expectedVersion) {
  if (status === 404) return { state: 'absent' };
  if (status < 200 || status >= 300) throw new Error(`GHCR preflight failed closed with HTTP ${status}`);
  if (!Array.isArray(body)) throw new Error('GHCR preflight returned malformed package versions');
  if (body.length >= 100) throw new Error('GHCR preflight result is incomplete; bounded page is full');
  const matches = body.filter((entry) => entry?.metadata?.container?.tags?.includes(expectedVersion));
  const latest = body.filter((entry) => entry?.metadata?.container?.tags?.includes('latest'));
  if (matches.length > 1) throw new Error('GHCR preflight found duplicate version tags');
  if (latest.length > 1) throw new Error('GHCR preflight found duplicate latest tags');
  const latestVersions = latest[0]?.metadata?.container?.tags?.filter((tag) => /^\d+\.\d+\.\d+$/u.test(tag)) ?? [];
  if (latest.length === 1 && latestVersions.length !== 1) throw new Error('GHCR latest tag lacks one exact version identity');
  const latestVersion = latestVersions[0] ?? null;
  return matches.length === 1 ? { state: 'match', id: matches[0].id, latestVersion } : { state: 'absent', latestVersion };
}

export function classifyGitHubRelease(status, body, expected) {
  if (status === 404) return { state: 'absent' };
  if (status < 200 || status >= 300) throw new Error(`GitHub Release preflight failed closed with HTTP ${status}`);
  if (!body || body.tag_name !== expected.tag || body.prerelease) throw new Error('GitHub Release preflight identity mismatch');
  if (body.draft === true) {
    if (body.immutable === true) throw new Error('GitHub Release draft cannot be immutable');
    return { state: 'draft', id: body.id };
  }
  if (body.immutable !== true) throw new Error('GitHub Release is not immutable');
  return { state: 'match', id: body.id };
}

export function classifyGitHubAttestations(status, body, expected) {
  if (status === 404) return { state: 'absent' };
  if (status < 200 || status >= 300) throw new Error(`GitHub attestation preflight failed closed with HTTP ${status}`);
  if (!Array.isArray(body?.attestations)) throw new Error('GitHub attestation preflight returned malformed data');
  let matches = 0;
  for (const attestation of body.attestations) {
    const payload = attestation?.bundle?.dsseEnvelope?.payload;
    if (typeof payload !== 'string') throw new Error('GitHub attestation preflight returned malformed bundle');
    let statement;
    try {
      statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    } catch {
      throw new Error('GitHub attestation preflight returned malformed statement');
    }
    if (statement.predicateType !== 'https://slsa.dev/provenance/v1') continue;
    if (statement.subject?.some((subject) => subject.name === expected.name && subject.digest?.sha256 === expected.digest)) matches += 1;
  }
  return matches > 0 ? { state: 'match' } : { state: 'absent' };
}

export function validateTagEvidence(evidence) {
  if (!/^v\d+\.\d+\.\d+$/u.test(evidence.tag)) throw new Error('release tag must be vX.Y.Z');
  if (evidence.objectType !== 'tag') throw new Error('release tag must be annotated');
  if (!/^[0-9a-f]{40}$/u.test(evidence.peeledCommit)) throw new Error('release tag commit is invalid');
  if (evidence.peeledCommit !== evidence.checkoutCommit || evidence.peeledCommit !== evidence.eventCommit) {
    throw new Error('release tag commit does not match checkout and event');
  }
  if (evidence.mainAncestor !== true) throw new Error('release tag commit is not on origin/main');
  if (evidence.packageVersion !== evidence.tag.slice(1)) throw new Error('release tag does not match package version');
  return { version: evidence.packageVersion, commit: evidence.peeledCommit };
}

export function createReleaseEvidence(input) {
  const required = [
    'releaseTag', 'releaseCommit', 'seedbedVersion', 'npmSha256', 'npmIntegrity',
    'closureSha256', 'imageDigest', 'imageSbomSha256', 'imageManifestSha256',
    'provenanceEvidenceSha256', 'immutableSettingEvidenceTag',
  ];
  for (const name of required) if (!input[name]) throw new Error(`missing ${name}`);
  const components = input.seedbedVersion === '0.2.2'
    ? { diamond: '0.4.0', taproot: '0.3.0', workshop: '0.3.3' }
    : { diamond: '0.4.1', taproot: '0.4.1', workshop: '0.4.1' };
  return {
    schemaVersion: 1,
    package: { name: '@gnolith/seedbed', version: input.seedbedVersion, sha256: input.npmSha256, integrity: input.npmIntegrity },
    source: {
      repository: 'https://github.com/gnolith/seedbed', tag: input.releaseTag,
      commit: input.releaseCommit, workflow: '.github/workflows/release.yml',
      immutableReleaseSettingVerifiedFor: input.immutableSettingEvidenceTag,
    },
    components,
    closure: { sha256: input.closureSha256 },
    image: {
      reference: `ghcr.io/gnolith/seedbed@${input.imageDigest}`,
      digest: input.imageDigest,
      manifestSha256: input.imageManifestSha256,
      sbomSha256: input.imageSbomSha256,
      provenanceVerificationSha256: input.provenanceEvidenceSha256,
    },
  };
}

async function main() {
  const [kind, url, ...args] = process.argv.slice(2);
  const headers = kind !== 'npm' && process.env.GITHUB_TOKEN ? {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    'x-github-api-version': '2026-03-10',
  } : undefined;
  const response = await requestJson(url, { headers });
  let result;
  if (kind === 'npm') {
    const [name, version, integrity] = args;
    result = classifyNpmVersion(response.status, response.body, { name, version, integrity });
  } else if (kind === 'ghcr') {
    result = classifyGhcrVersions(response.status, response.body, args[0]);
  } else if (kind === 'release') {
    result = classifyGitHubRelease(response.status, response.body, { tag: args[0] });
  } else if (kind === 'attestation') {
    result = classifyGitHubAttestations(response.status, response.body, { name: args[0], digest: args[1] });
  } else {
    throw new Error('usage: release-preflight.mjs npm|ghcr|release|attestation URL ...');
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

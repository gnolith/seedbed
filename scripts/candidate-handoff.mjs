import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import YAML from 'yaml';

const refreshAttestation = process.argv.includes('--refresh-attestation');
const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
if (!refreshAttestation && status.trim()) throw new Error('candidate handoff requires a clean committed worktree');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!refreshAttestation) {
  runNpm(['run', 'check'], { stdio: 'inherit' });
  runNpm(['run', 'test:packed'], { stdio: 'inherit' });
  runNpm(['run', 'test:compose'], { stdio: 'inherit' });
  runNpm(['run', 'test:docker'], { stdio: 'inherit' });
  runNpm(['run', 'test:legacy-docker'], { stdio: 'inherit' });
}

const output = resolve('candidate', refreshAttestation ? '.attestation-refresh' : `seedbed-0.4.0-${commit.slice(0, 12)}`);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const packed = JSON.parse(runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', output], { encoding: 'utf8' }))[0];
const packagePath = join(output, packed.filename);
await writeDeterministicTarGzip(
  join(output, 'seedbed-compose-bundle.tar.gz'),
  ['compose', 'docker', 'examples', 'fixtures', 'components', 'seedbed-component-lock.json', 'migration-order.json'],
);
const sbom = runNpm(['sbom', '--omit=dev', '--sbom-format', 'cyclonedx'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
await writeFile(join(output, 'seedbed-sbom.cdx.json'), sbom);
const compose = YAML.parse(await readFile('compose/compose.yaml', 'utf8'));
const componentLockBytes = await readFile('seedbed-component-lock.json');
const componentLock = JSON.parse(componentLockBytes);
const legacyFixture = JSON.parse(await readFile('fixtures/legacy-local-v1/fixture-evidence.json', 'utf8'));
const localBuild = JSON.parse(await readFile('seedbed-assembly-attestation.json', 'utf8'));
await writeFile(join(output, 'compose-graph.json'), `${JSON.stringify({
  profiles: { default: ['workshop'], qdrant: ['workshop', 'qdrant'] },
  waystoneAssets: { enabledByDefault: true, prefix: '/app' },
  unavailableProfiles: {
    ollama: {
      disposition: 'unavailable',
      requires: 'immutable-model-artifact-selector-and-digest-v1',
    },
  },
  services: Object.keys(compose.services).sort(),
  publishedPorts: { workshop: ['127.0.0.1:${WORKSHOP_PORT}:4317'], qdrant: [] },
  nodeImage: componentLock.compose.nodeImage,
  qdrantImage: componentLock.compose.qdrantImage,
  components: componentLock.packages,
  migrations: componentLock.migrations,
  legacyFixture: {
    format: legacyFixture.format,
    sha256: legacyFixture.snapshot.sha256,
    counts: legacyFixture.expectedOwnerCounts,
    semanticConfigurationCount: legacyFixture.dispositions.semanticConfiguration.count,
    onboarding: legacyFixture.dispositions.onboarding,
  },
  applicationImagePublished: false,
}, null, 2)}\n`);
const actualLocalBuild = {
  kind: 'seedbed-local-build-v1',
  selector: componentLock.localBuildSelector,
  pullPolicy: 'never',
  componentLockSha256: sha256(componentLockBytes),
  graphSha256: sha256(await readFile(join(output, 'compose-graph.json'))),
  composeBundleSha256: sha256(await readFile(join(output, 'seedbed-compose-bundle.tar.gz'))),
};
if (refreshAttestation) {
  await writeFile('seedbed-assembly-attestation.json', `${JSON.stringify(actualLocalBuild, null, 2)}\n`);
  await rm(output, { recursive: true, force: true });
  console.log('refreshed seedbed-assembly-attestation.json');
  process.exit(0);
}
if (JSON.stringify(localBuild) !== JSON.stringify(actualLocalBuild)) {
  throw new Error('public local-build attestation does not match the exact candidate graph');
}
const artifacts = [packagePath, join(output, 'seedbed-compose-bundle.tar.gz'), join(output, 'seedbed-sbom.cdx.json'), join(output, 'compose-graph.json')];
const checksums = [];
for (const artifact of artifacts) checksums.push(`${sha256(await readFile(artifact))}  ${artifact.split(/[\\/]/u).at(-1)}`);
await writeFile(join(output, 'SHA256SUMS'), `${checksums.sort().join('\n')}\n`);
await writeFile(join(output, 'candidate.json'), `${JSON.stringify({
  format: 'gnolith-seedbed-candidate-handoff-v1',
  commit,
  version: '0.4.0',
  packageSha256: sha256(await readFile(packagePath)),
  composeBundleSha256: sha256(await readFile(join(output, 'seedbed-compose-bundle.tar.gz'))),
  sbomSha256: sha256(await readFile(join(output, 'seedbed-sbom.cdx.json'))),
  graphSha256: sha256(await readFile(join(output, 'compose-graph.json'))),
  componentLockSha256: sha256(componentLockBytes),
  localBuild,
  components: componentLock.packages,
  legacyFixture: {
    sha256: legacyFixture.snapshot.sha256,
    bytes: legacyFixture.snapshot.bytes,
    evidenceFormat: legacyFixture.format,
  },
  releaseCreated: false,
  imagePublished: false,
}, null, 2)}\n`);
console.log(output);

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function runNpm(args, options) {
  if (!process.env.npm_execpath) throw new Error('candidate handoff must run through npm');
  return execFileSync(process.execPath, [process.env.npm_execpath, ...args], options);
}

async function writeDeterministicTarGzip(destination, roots) {
  const entries = [];
  for (const root of roots) await collectRegularFiles(root, root.replaceAll('\\', '/'), entries);
  entries.sort((left, right) => left.archivePath.localeCompare(right.archivePath));
  const blocks = [];
  for (const entry of entries) {
    const bytes = await readFile(entry.sourcePath);
    blocks.push(createTarHeader(entry.archivePath, bytes.byteLength), bytes);
    const remainder = bytes.byteLength % 512;
    if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder));
  }
  blocks.push(Buffer.alloc(1024));
  const compressed = gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 });
  // RFC 1952 permits 255 ("unknown") and avoids zlib host-OS variance.
  compressed[9] = 255;
  await writeFile(destination, compressed, { flag: 'wx', mode: 0o600 });
}

async function collectRegularFiles(sourcePath, archivePath, entries) {
  const metadata = await lstat(sourcePath);
  if (metadata.isSymbolicLink()) throw new Error(`candidate bundle refuses symbolic link ${archivePath}`);
  if (metadata.isFile()) {
    entries.push({ sourcePath, archivePath });
    return;
  }
  if (!metadata.isDirectory()) throw new Error(`candidate bundle refuses non-regular entry ${archivePath}`);
  for (const child of await readdir(sourcePath)) {
    await collectRegularFiles(join(sourcePath, child), `${archivePath}/${child}`, entries);
  }
}

function createTarHeader(path, size) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarPath(path);
  writeTarText(header, name, 0, 100);
  writeTarOctal(header, 0o644, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, size, 124, 12);
  writeTarOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeTarText(header, 'ustar\0', 257, 6);
  writeTarText(header, '00', 263, 2);
  writeTarText(header, 'root', 265, 32);
  writeTarText(header, 'root', 297, 32);
  writeTarText(header, prefix, 345, 155);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const encoded = checksum.toString(8).padStart(6, '0');
  writeTarText(header, `${encoded}\0 `, 148, 8);
  return header;
}

function splitTarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  for (let index = path.lastIndexOf('/'); index > 0; index = path.lastIndexOf('/', index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`candidate bundle path exceeds ustar limits: ${path}`);
}

function writeTarText(header, value, offset, length) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength > length) throw new Error('candidate bundle field exceeds ustar limits');
  bytes.copy(header, offset);
}

function writeTarOctal(header, value, offset, length) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('candidate bundle contains invalid numeric field');
  writeTarText(header, `${value.toString(8).padStart(length - 1, '0')}\0`, offset, length);
}

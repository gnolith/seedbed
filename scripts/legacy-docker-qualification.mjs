import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  applyLegacyAdoption,
  canonicalJson,
  planLegacyAdoption,
  validateConfig,
  validateLegacyManifest,
} from '../dist/index.js';
import { OperatorLegacyDecoder } from '../dist/legacy-source.js';
import {
  DockerComposeDriver,
  OperatorAdoptionTarget,
} from '../dist/system-drivers.js';
import { createOperatorOwnerPorts } from '../dist/owner-ports.js';

const exec = promisify(execFile);
const root = resolve('.');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'gnolith-seedbed-legacy-docker-'));
const evidence = JSON.parse(await readFile(join(root, 'fixtures', 'legacy-local-v1', 'fixture-evidence.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'seedbed-component-lock.json'), 'utf8'));
const suffix = evidence.snapshot.sha256.slice(0, 16);
const projectName = `gnolith-legacy-${suffix}`;
const dataVolume = `${projectName}-data`;
const stateDirectory = join(temporaryRoot, 'state');
const composeDirectory = join(stateDirectory, 'compose');
const driver = new DockerComposeDriver(root);

try {
  const manifest = validateLegacyManifest({
    format: 'gnolith-legacy-local-adoption-v1',
    source: {
      kind: 'seedbed-snapshot',
      snapshotPath: join(root, 'fixtures', 'legacy-local-v1', evidence.snapshot.path),
    },
    expectedInstallationId: evidence.snapshot.installationId,
    expectedBaseIri: evidence.snapshot.baseIri,
    expectedPackages: {
      diamond: '0.4.1',
      taproot: '0.4.2',
      workshop: '0.4.2',
      seedbed: '0.3.2',
    },
    targetComposeProject: projectName,
  });
  const config = validateConfig({
    formatVersion: 1,
    installationId: evidence.snapshot.installationId,
    baseIri: evidence.snapshot.baseIri,
    packages: lock.packages,
    compose: {
      projectName,
      workshopPort: 4317,
      publishIpv6Loopback: false,
      profiles: [],
      networkName: projectName,
      dataVolume,
      nodeImage: lock.compose.nodeImage,
      qdrantImage: lock.compose.qdrantImage,
    },
    paths: {
      stateDirectory,
      dataDirectory: join(temporaryRoot, 'data'),
      backupDirectory: join(temporaryRoot, 'backups'),
    },
    authentication: {
      mode: 'local-bearer-v1',
      credentialId: 'legacy-fixture-owner',
      tokenFile: join(stateDirectory, 'protected', 'bearer'),
    },
    endpoints: {},
    migrations: lock.migrations,
    backup: lock.backup,
  }, { projectDirectory: root });
  await driver.prepare(config);
  await exec('docker', [
    'compose',
    '--project-name', projectName,
    '--file', join(composeDirectory, 'compose.yaml'),
    '--env-file', join(composeDirectory, 'compose.env'),
    'build', '--no-cache', 'workshop',
  ], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const decoder = new OperatorLegacyDecoder(config, driver);
  const plan = await planLegacyAdoption({ manifest, config, decoder });
  if (
    canonicalJson(plan.counts) !== canonicalJson(evidence.expectedOwnerCounts)
    || canonicalJson(plan.payloadDigests) !== canonicalJson(evidence.payloads)
    || plan.sourceDigests.snapshotPath !== evidence.snapshot.sha256
  ) throw new Error('Frozen legacy fixture plan does not match its intentional evidence');
  const result = await applyLegacyAdoption({
    manifest,
    plan,
    config,
    decoder,
    target: new OperatorAdoptionTarget(config, driver),
  });
  if (
    result.issues.length !== 0
    || canonicalJson(result.verification.counts) !== canonicalJson(evidence.expectedOwnerCounts)
    || canonicalJson(result.verification.payloadDigests) !== canonicalJson(evidence.payloads)
  ) throw new Error('Frozen legacy fixture full adoption lost intentional evidence');
  const owners = createOperatorOwnerPorts(config, driver);
  for (const owner of ['diamond', 'taproot', 'workshop']) {
    const diagnostic = await owners[owner].diagnose();
    if (!diagnostic.ready || diagnostic.schemaVersion !== lock.migrations[owner]) {
      throw new Error(`${owner} is not exact and migration-ready after legacy adoption`);
    }
  }
  console.log(`verified full two-process public legacy adoption ${evidence.snapshot.sha256}`);
} finally {
  await exec('docker', [
    'compose',
    '--project-name', projectName,
    '--file', join(composeDirectory, 'compose.yaml'),
    '--env-file', join(composeDirectory, 'compose.env'),
    'down', '--remove-orphans',
  ], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }).catch(() => undefined);
  await exec('docker', ['volume', 'rm', dataVolume], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}

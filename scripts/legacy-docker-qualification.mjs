import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve('.');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'gnolith-seedbed-legacy-docker-'));
const packed = await installPackedSeedbed();
const seedbed = await import(pathToFileURL(join(packed.root, 'dist', 'index.js')).href);
const { DockerComposeDriver } = await import(pathToFileURL(join(packed.root, 'dist', 'system-drivers.js')).href);
const { createOperatorOwnerPorts } = await import(pathToFileURL(join(packed.root, 'dist', 'owner-ports.js')).href);
const evidence = JSON.parse(await readFile(join(packed.root, 'fixtures', 'legacy-local-v1', 'fixture-evidence.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(packed.root, 'seedbed-component-lock.json'), 'utf8'));
const suffix = evidence.snapshot.sha256.slice(0, 16);
const projectName = `gnolith-legacy-${suffix}`;
const dataVolume = `${projectName}-data`;
const stateDirectory = join(temporaryRoot, 'state');
const composeDirectory = join(stateDirectory, 'compose');
const driver = new DockerComposeDriver(packed.root);

try {
  const manifest = seedbed.validateLegacyManifest({
    format: 'gnolith-legacy-local-adoption-v1',
    source: {
      kind: 'seedbed-snapshot',
      snapshotPath: join(packed.root, 'fixtures', 'legacy-local-v1', evidence.snapshot.path),
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
  const config = seedbed.validateConfig({
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
  }, { projectDirectory: packed.project });
  const configPath = join(packed.project, 'seedbed.config.json');
  const manifestPath = join(packed.project, 'manifest.json');
  const planPath = join(packed.project, 'adopt-plan.json');
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await driver.prepare(config);
  await exec('docker', [
    'compose',
    '--project-name', projectName,
    '--file', join(composeDirectory, 'compose.yaml'),
    '--env-file', join(composeDirectory, 'compose.env'),
    'build', '--no-cache', 'workshop',
  ], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const inspectStarted = Date.now();
  await runPackedCli(packed.cli, [
    'adopt', 'legacy-local', 'plan',
    '--config', configPath,
    '--manifest', manifestPath,
    '--out', planPath,
  ]);
  const inspectElapsedMs = Date.now() - inspectStarted;
  if (inspectElapsedMs > 10_000) throw new Error(`public legacy plan exceeded 10 seconds (${inspectElapsedMs}ms)`);
  const invalidManifestPath = join(packed.project, 'invalid-manifest.json');
  await writeFile(invalidManifestPath, `${JSON.stringify({
    ...manifest,
    expectedBaseIri: 'https://fixture.invalid/intentionally-wrong',
  }, null, 2)}\n`, { mode: 0o600 });
  const invalidFirst = await expectPackedCliFailure(packed.cli, [
    'adopt', 'legacy-local', 'plan',
    '--config', configPath,
    '--manifest', invalidManifestPath,
  ]);
  const invalidSecond = await expectPackedCliFailure(packed.cli, [
    'adopt', 'legacy-local', 'plan',
    '--config', configPath,
    '--manifest', invalidManifestPath,
  ]);
  if (
    invalidFirst !== invalidSecond
    || invalidFirst.includes(temporaryRoot)
  ) throw new Error('invalid public legacy plan did not fail stably and opaquely');
  const operatorChildren = await exec('docker', [
    'ps', '--all', '--quiet',
    '--filter', 'name=gnolith-seedbed-op-',
    '--filter', `label=com.docker.compose.project=${projectName}`,
  ], { windowsHide: true, maxBuffer: 1024 * 1024 });
  if (operatorChildren.stdout.trim()) throw new Error('legacy owner inspect left a Seedbed operator child container');
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  if (
    seedbed.canonicalJson(plan.counts) !== seedbed.canonicalJson(evidence.expectedOwnerCounts)
    || seedbed.canonicalJson(plan.payloadDigests) !== seedbed.canonicalJson(evidence.payloads)
    || plan.sourceDigests.snapshotPath !== evidence.snapshot.sha256
  ) throw new Error('Frozen legacy fixture plan does not match its intentional evidence');
  const applied = await runPackedCli(packed.cli, [
    'adopt', 'legacy-local', 'apply',
    '--config', configPath,
    '--manifest', manifestPath,
    '--plan', planPath,
  ]);
  const result = JSON.parse(applied.stdout);
  if (
    result.issues.length !== 0
    || seedbed.canonicalJson(result.verification.counts) !== seedbed.canonicalJson(evidence.expectedOwnerCounts)
    || seedbed.canonicalJson(result.verification.payloadDigests) !== seedbed.canonicalJson(evidence.payloads)
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

async function installPackedSeedbed() {
  if (!process.env.npm_execpath) throw new Error('Legacy qualification must run through npm');
  const artifacts = join(temporaryRoot, 'packed-artifacts');
  const project = join(temporaryRoot, 'packed-cli');
  await mkdir(artifacts, { recursive: true });
  await mkdir(project, { recursive: true });
  const result = await exec(process.execPath, [
    process.env.npm_execpath,
    'pack', '--json', '--ignore-scripts', '--pack-destination', artifacts,
  ], { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const metadata = JSON.parse(result.stdout);
  const archive = join(artifacts, metadata[0].filename);
  await exec(process.execPath, [process.env.npm_execpath, 'init', '--yes'], {
    cwd: project, windowsHide: true, maxBuffer: 1024 * 1024,
  });
  await exec(process.execPath, [process.env.npm_execpath, 'install', '--ignore-scripts', archive], {
    cwd: project, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  const installedRoot = join(project, 'node_modules', '@gnolith', 'seedbed');
  return { project, root: installedRoot, cli: join(installedRoot, 'dist', 'cli.js') };
}

async function runPackedCli(cli, args) {
  return exec(process.execPath, [cli, ...args], {
    cwd: dirname(cli),
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function expectPackedCliFailure(cli, args) {
  try {
    await runPackedCli(cli, args);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 2 || !('stderr' in error)) throw error;
    const lines = String(error.stderr).trim().split(/\r?\n/u).reverse();
    const structured = lines.find((line) => {
      try {
        const value = JSON.parse(line);
        return value && typeof value === 'object' && typeof value.error === 'string';
      } catch {
        return false;
      }
    });
    if (!structured) throw error;
    return JSON.stringify(JSON.parse(structured));
  }
  throw new Error('invalid public legacy plan unexpectedly succeeded');
}

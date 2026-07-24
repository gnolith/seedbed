import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { createDefaultSeedbedControl } from '../dist/local-control.js';
import {
  createInstallationBackup,
  digestObject,
  restoreInstallationBackup,
  validateConfig,
  verifyInstallationBackup,
} from '../dist/index.js';
import { createOperatorOwnerPorts } from '../dist/owner-ports.js';
import { ComposeRestoreTarget, DockerComposeDriver } from '../dist/system-drivers.js';

const exec = promisify(execFile);
const root = resolve('.');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'gnolith-seedbed-docker-'));
const stateRoot = join(temporaryRoot, 'state');
const lock = JSON.parse(await readFile(join(root, 'seedbed-component-lock.json'), 'utf8'));
const localBuild = JSON.parse(await readFile(join(root, 'seedbed-assembly-attestation.json'), 'utf8'));
const installationId = `seedbed-docker-${digestObject({ root, at: Date.now() }).slice(0, 24)}`;
const key = digestObject(installationId).slice(0, 24);
const projectName = `gnolith-${key}`;
const composeDirectory = join(stateRoot, 'installations', key, 'compose');
const restoreKey = `${key}-restore`;
const restoreProjectName = `gnolith-${restoreKey}`;
const restoreState = join(temporaryRoot, 'restore-state');
const restoreComposeDirectory = join(restoreState, 'compose');
const port = await availablePort();

try {
  const control = createDefaultSeedbedControl({ projectRoot: root, stateRoot, artifactRoot: root });
  const request = {
    installationId,
    baseIri: `https://local.gnolith.invalid/${installationId}/`,
    endpoint: `http://127.0.0.1:${port}/mcp`,
    image: localBuild,
    expected: {
      installationId,
      baseIri: `https://local.gnolith.invalid/${installationId}/`,
      serverVersion: lock.packages.workshop.version,
      operationVersion: lock.migrations.workshop,
      catalogDigest: lock.migrations.expectedCatalogDigest,
      migrationReady: true,
      canonicalReady: true,
      authorizationReady: true,
      lexicalReady: true,
      blobReady: true,
      producerStatus: 'ready',
      semanticState: 'absent',
      allowLexicalOnly: true,
    },
  };
  const receipt = await control.apply(await control.plan(request));
  const token = (await readFile(receipt.protectedTokenFile.canonicalPath, 'utf8')).trim();
  const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const status = await response.json();
  if (
    !response.ok
    || status.installationId !== installationId
    || status.baseIri !== request.baseIri
    || status.versions?.server !== lock.packages.workshop.version
    || status.operationCatalogDigest !== lock.migrations.expectedCatalogDigest
    || status.migrationReadiness?.ready !== true
    || status.canonicalReady !== true
    || status.authorizationReady !== true
    || status.lexicalReady !== true
    || status.blobReady !== true
  ) throw new Error('authenticated Workshop readiness did not match the exact component lock');

  const sourceConfig = installationConfig({
    installationId,
    baseIri: request.baseIri,
    projectName,
    dataVolume: `${projectName}-data`,
    stateDirectory: join(stateRoot, 'installations', key),
    tokenFile: receipt.protectedTokenFile.canonicalPath,
    port,
  });
  const sourceDriver = new DockerComposeDriver(root);
  const sourcePorts = createOperatorOwnerPorts(sourceConfig, sourceDriver);
  const backupPath = join(temporaryRoot, 'installation-backup.json');
  await createInstallationBackup({ config: sourceConfig, ports: sourcePorts, destination: backupPath });
  await verifyInstallationBackup(backupPath, sourceConfig, sourcePorts);

  const restoreTokenFile = join(restoreState, 'secrets', 'bearer');
  await mkdir(join(restoreState, 'secrets'), { recursive: true });
  await writeFile(restoreTokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(restoreTokenFile, 0o600);
  const restoreConfig = installationConfig({
    installationId,
    baseIri: request.baseIri,
    projectName: restoreProjectName,
    dataVolume: `${restoreProjectName}-data`,
    stateDirectory: restoreState,
    tokenFile: restoreTokenFile,
    port: await availablePort(),
  });
  const restoreDriver = new DockerComposeDriver(root);
  await restoreDriver.prepare(restoreConfig);
  await restoreDriver.buildOperator(restoreConfig);
  const restorePorts = createOperatorOwnerPorts(restoreConfig, restoreDriver);
  await restoreInstallationBackup({
    path: backupPath,
    config: restoreConfig,
    ports: restorePorts,
    target: new ComposeRestoreTarget(restoreConfig, restoreDriver),
  });
  for (const owner of ['diamond', 'taproot', 'workshop']) {
    const diagnostic = await restorePorts[owner].diagnose();
    const readinessMatchesDisposition = owner === 'taproot' || diagnostic.ready;
    if (
      !readinessMatchesDisposition
      || diagnostic.schemaVersion !== lock.migrations[owner]
      || diagnostic.ledger.namespace !== `@gnolith/${owner}`
      || !/^[0-9a-f]{64}$/u.test(diagnostic.ledger.digest)
    ) {
      throw new Error(`${owner} restore diagnostics did not match the exact component lock: ${JSON.stringify(diagnostic)}`);
    }
  }
  console.log('verified exact pinned local Docker graph, bootstrap, authenticated readiness, and owner backup/restore');
} finally {
  await cleanupCompose(projectName, composeDirectory, `${projectName}-data`);
  await cleanupCompose(restoreProjectName, restoreComposeDirectory, `${restoreProjectName}-data`);
  await rm(temporaryRoot, { recursive: true, force: true });
}

function installationConfig(input) {
  return validateConfig({
    formatVersion: 1,
    installationId: input.installationId,
    baseIri: input.baseIri,
    packages: lock.packages,
    compose: {
      projectName: input.projectName,
      workshopPort: input.port,
      publishIpv6Loopback: false,
      profiles: lock.compose.profiles,
      networkName: input.projectName,
      dataVolume: input.dataVolume,
      nodeImage: lock.compose.nodeImage,
    },
    paths: {
      stateDirectory: input.stateDirectory,
      dataDirectory: join(input.stateDirectory, 'data'),
      backupDirectory: join(input.stateDirectory, 'backups'),
    },
    authentication: {
      mode: 'local-bearer-v1',
      credentialId: `local-${key}`,
      tokenFile: input.tokenFile,
    },
    endpoints: {},
    migrations: lock.migrations,
    backup: lock.backup,
  }, { projectDirectory: root });
}

async function cleanupCompose(name, directory, volume) {
  await exec('docker', [
    'compose', '--project-name', name,
    '--file', join(directory, 'compose.yaml'),
    '--env-file', join(directory, 'compose.env'),
    'down', '--remove-orphans',
  ], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }).catch(() => undefined);
  await exec('docker', ['volume', 'rm', volume], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  if (!Number.isSafeInteger(port) || port < 1) throw new Error('could not reserve a loopback qualification port');
  return port;
}

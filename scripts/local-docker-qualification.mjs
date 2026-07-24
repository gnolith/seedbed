import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import {
  digestObject,
  restoreInstallationBackup,
  semanticConfigurationFingerprint,
  validateConfig,
} from '../dist/index.js';
import { createOperatorOwnerPorts } from '../dist/owner-ports.js';
import { ComposeRestoreTarget, DockerComposeDriver } from '../dist/system-drivers.js';

const exec = promisify(execFile);
const root = resolve('.');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'gnolith-seedbed-docker-'));
const stateRoot = join(temporaryRoot, 'state');
const lock = JSON.parse(await readFile(join(root, 'seedbed-component-lock.json'), 'utf8'));
const installationId = `seedbed-docker-${digestObject({ root, at: Date.now() }).slice(0, 24)}`;
const key = digestObject(installationId).slice(0, 24);
const projectName = `gnolith-${key}`;
const composeDirectory = join(stateRoot, 'installations', key, 'compose');
const restoreKey = `${key}-restore`;
const restoreProjectName = `gnolith-${restoreKey}`;
const restoreState = join(temporaryRoot, 'restore-state');
const restoreComposeDirectory = join(restoreState, 'compose');
const compatibilityKey = `${key}-compatibility`;
const compatibilityProjectName = `gnolith-${compatibilityKey}`;
const compatibilityState = join(temporaryRoot, 'compatibility-state');
const compatibilityComposeDirectory = join(compatibilityState, 'compose');
const port = await availablePort();
const semanticCleanups = [];

try {
  const packed = await installPackedSeedbed();
  const packedControl = await import(pathToFileURL(join(packed.root, 'dist', 'local-control.js')).href);
  const basePolicy = packedControl.defaultSeedbedControlPolicy({
    projectRoot: packed.project,
    stateRoot,
    artifactRoot: packed.root,
  });
  const control = packedControl.createSeedbedControl({
    ...basePolicy,
    compose: { ...basePolicy.compose, profiles: ['waystone'] },
  });
  const request = {
    installationId,
    baseIri: `https://local.gnolith.invalid/${installationId}`,
    endpoint: `http://127.0.0.1:${port}/mcp`,
    image: basePolicy.localBuild,
    expected: {
      installationId,
      baseIri: `https://local.gnolith.invalid/${installationId}`,
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

  await verifyWaystoneAssets(port, token);
  await callMcp(port, token, 'create_item', {
    idempotencyKey: `seedbed-backup-populated-${key}`,
    authoredText: 'Seedbed populated backup verification fixture',
    data: {
      id: 'Q900001',
      labels: { en: { language: 'en', value: 'Seedbed populated fixture' } },
    },
  });
  const beforeRestartResponse = await fetch(`http://127.0.0.1:${port}/health/ready`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const beforeRestartStatus = await beforeRestartResponse.json();
  const beforeRestartStatusTool = await callMcp(port, token, 'gnolith_status', {});
  const beforeRestartSearchHealth = await callMcp(port, token, 'search_admin', { action: 'health' });
  if (
    beforeRestartResponse.status !== 503
    || beforeRestartStatus.lexicalReady !== false
    || beforeRestartStatus.operationCatalogDigest !== lock.migrations.expectedCatalogDigest
    || beforeRestartStatusTool.structuredContent?.lexicalReady !== false
    || beforeRestartStatusTool.structuredContent?.operationCatalogDigest !== lock.migrations.expectedCatalogDigest
    || beforeRestartSearchHealth.structuredContent?.materialization?.status !== 'building'
    || beforeRestartSearchHealth.structuredContent.materialization.sourceHighWatermark
      <= beforeRestartSearchHealth.structuredContent.materialization.activeAppliedWatermark
  ) throw new Error('post-mutation Workshop readiness did not report bounded lexical catch-up truthfully');

  const selector = { installationId, projectRoot: packed.project };
  await composeCommand(projectName, composeDirectory, ['stop', 'workshop']);
  await assertRepairDiagnosis(control, selector, receipt.operationId, token);
  await control.resume(receipt.operationId);
  await assertAuthenticatedReady(port, token);
  await control.resume(receipt.operationId);
  await assertSingleWorkshopContainer(projectName, composeDirectory);

  const workshopContainer = `${projectName}-workshop-1`;
  await exec('docker', ['kill', workshopContainer], { windowsHide: true, maxBuffer: 1024 * 1024 });
  await assertRepairDiagnosis(control, selector, receipt.operationId, token);
  await control.resume(receipt.operationId);
  await assertAuthenticatedReady(port, token);

  await composeCommand(projectName, composeDirectory, ['down', '--remove-orphans']);
  await assertRepairDiagnosis(control, selector, receipt.operationId, token);
  await control.resume(receipt.operationId);
  await assertAuthenticatedReady(port, token);
  await assertSingleWorkshopContainer(projectName, composeDirectory);

  const sourceConfig = installationConfig({
    installationId,
    baseIri: request.baseIri,
    projectName,
    dataVolume: `${projectName}-data`,
    stateDirectory: join(stateRoot, 'installations', key),
    tokenFile: receipt.protectedTokenFile.canonicalPath,
    port,
    profiles: ['waystone'],
  });
  await composeCommand(projectName, composeDirectory, ['stop', 'workshop']);
  const beforeVerify = await snapshotVolume(`${projectName}-data`);
  if (beforeVerify.files.some((file) => /(?:-journal|-shm|-wal)$/u.test(file.path))) {
    throw new Error(`cleanly stopped live installation retained SQLite sidecars: ${JSON.stringify(beforeVerify.files)}`);
  }

  const sourceConfigPath = join(packed.project, 'source-config.json');
  await writeFile(sourceConfigPath, `${JSON.stringify(sourceConfig, null, 2)}\n`);
  const backupPath = join(temporaryRoot, 'installation-backup.json');
  await runPackedCli(packed.cli, ['backup', 'create', '--config', sourceConfigPath, '--out', backupPath]);
  await runPackedCli(packed.cli, ['backup', 'inspect', '--config', sourceConfigPath, '--archive', backupPath]);
  await runPackedCli(packed.cli, ['backup', 'verify', '--config', sourceConfigPath, '--archive', backupPath]);
  const afterVerify = await snapshotVolume(`${projectName}-data`);
  if (JSON.stringify(afterVerify) !== JSON.stringify(beforeVerify)) {
    throw new Error('packed backup verify changed live database/blob bytes or created a sidecar');
  }

  const tamperedPath = join(temporaryRoot, 'installation-backup-tampered.json');
  const tampered = Buffer.from(await readFile(backupPath));
  tampered[Math.max(0, tampered.byteLength - 2)] ^= 1;
  await writeFile(tamperedPath, tampered);
  await expectPackedCliFailure(packed.cli, ['backup', 'verify', '--config', sourceConfigPath, '--archive', tamperedPath]);
  if (JSON.stringify(await snapshotVolume(`${projectName}-data`)) !== JSON.stringify(beforeVerify)) {
    throw new Error('tampered packed backup verification changed the live installation');
  }

  const compatibilityConfig = installationConfig({
    installationId,
    baseIri: request.baseIri,
    projectName: compatibilityProjectName,
    dataVolume: `${compatibilityProjectName}-data`,
    stateDirectory: compatibilityState,
    tokenFile: join(compatibilityState, 'secrets', 'bearer'),
    port: await availablePort(),
    profiles: ['waystone'],
  });
  const compatibilityConfigPath = join(packed.project, 'compatibility-config.json');
  const compatibilityPlanPath = join(packed.project, 'compatibility-plan.json');
  await writeFile(compatibilityConfigPath, `${JSON.stringify(compatibilityConfig, null, 2)}\n`);
  await runPackedCli(packed.cli, ['plan', '--config', compatibilityConfigPath, '--out', compatibilityPlanPath]);
  await runPackedCli(packed.cli, ['apply', '--config', compatibilityConfigPath, '--plan', compatibilityPlanPath]);
  await runPackedCli(packed.cli, ['backup', 'restore', '--config', compatibilityConfigPath, '--archive', backupPath, '--dry-run']);

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
    profiles: ['waystone'],
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
    if (
      !diagnostic.ready
      || diagnostic.schemaVersion !== lock.migrations[owner]
      || diagnostic.ledger.namespace !== `@gnolith/${owner}`
      || !/^[0-9a-f]{64}$/u.test(diagnostic.ledger.digest)
    ) {
      throw new Error(`${owner} restore diagnostics did not match the exact component lock: ${JSON.stringify(diagnostic)}`);
    }
  }
  await verifySemanticProfile(packed, 'sqlite');
  await verifySemanticProfile(packed, 'qdrant');
  console.log('verified exact pinned local Docker graph, repair, backup/restore, protected OpenAI semantic configuration, SQLite, and Qdrant');
} finally {
  for (const cleanup of semanticCleanups) {
    await cleanupCompose(cleanup.projectName, cleanup.composeDirectory, cleanup.dataVolume);
    if (cleanup.qdrantVolume) {
      await exec('docker', ['volume', 'rm', cleanup.qdrantVolume], {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }).catch(() => undefined);
    }
  }
  await cleanupCompose(projectName, composeDirectory, `${projectName}-data`);
  await cleanupCompose(compatibilityProjectName, compatibilityComposeDirectory, `${compatibilityProjectName}-data`);
  await cleanupCompose(restoreProjectName, restoreComposeDirectory, `${restoreProjectName}-data`);
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function verifySemanticProfile(packed, vectorKind) {
  const packedControl = await import(pathToFileURL(join(packed.root, 'dist', 'local-control.js')).href);
  const semanticInstallationId = `${installationId}-semantic-${vectorKind}`;
  const semanticKey = digestObject(semanticInstallationId).slice(0, 24);
  const semanticProjectName = `gnolith-${semanticKey}`;
  const semanticStateRoot = join(temporaryRoot, `semantic-${vectorKind}-state`);
  const semanticComposeDirectory = join(semanticStateRoot, 'installations', semanticKey, 'compose');
  const semanticPort = await availablePort();
  const providerSelectorPath = join(semanticStateRoot, 'protected', 'openai-profile');
  await mkdir(dirname(providerSelectorPath), { recursive: true });
  await writeFile(providerSelectorPath, 'qualification-profile-not-a-usable-api-key\n', { encoding: 'utf8', mode: 0o600 });
  await chmod(providerSelectorPath, 0o600);
  const policy = packedControl.defaultSeedbedControlPolicy({
    projectRoot: packed.project,
    stateRoot: semanticStateRoot,
    artifactRoot: packed.root,
  });
  const qdrant = vectorKind === 'qdrant';
  semanticCleanups.push({
    projectName: semanticProjectName,
    composeDirectory: semanticComposeDirectory,
    dataVolume: `${semanticProjectName}-data`,
    ...(qdrant ? { qdrantVolume: `${semanticProjectName}-qdrant` } : {}),
  });
  const control = packedControl.createSeedbedControl({
    ...policy,
    compose: {
      ...policy.compose,
      profiles: qdrant ? ['qdrant'] : [],
    },
  });
  const configuration = {
    version: 1,
    id: `qualification-${vectorKind}`,
    name: `Qualification ${vectorKind}`,
    provider: {
      kind: 'openai-compatible',
      endpoint: 'http://127.0.0.1:9',
      allowPrivateEndpoint: true,
      model: 'text-embedding-3-small',
      dimensions: 1536,
      metric: 'cosine',
      credentialSelector: 'openai-profile',
      redirectPolicy: 'error',
    },
    vector: qdrant
      ? {
          kind: 'qdrant',
          endpoint: 'http://qdrant:6333',
          collection: `gnolith-${semanticKey}`,
          credentialSelector: null,
          allowPrivateEndpoint: true,
          redirectPolicy: 'error',
        }
      : { kind: 'sqlite' },
  };
  const request = {
    installationId: semanticInstallationId,
    baseIri: `https://local.gnolith.invalid/${semanticInstallationId}`,
    endpoint: `http://127.0.0.1:${semanticPort}/mcp`,
    image: policy.localBuild,
    expected: {
      installationId: semanticInstallationId,
      baseIri: `https://local.gnolith.invalid/${semanticInstallationId}`,
      serverVersion: lock.packages.workshop.version,
      operationVersion: lock.migrations.workshop,
      catalogDigest: lock.migrations.expectedCatalogDigest,
      migrationReady: true,
      canonicalReady: true,
      authorizationReady: true,
      lexicalReady: true,
      blobReady: true,
      producerStatus: 'ready',
      semanticState: 'degraded',
      allowLexicalOnly: true,
    },
    semantic: {
      configuration,
      expectedRevision: 0,
      credentialSelectors: [{
        id: 'openai-profile',
        kind: 'protected-file-v1',
        path: providerSelectorPath,
      }],
    },
  };
  const receipt = await control.apply(await control.plan(request));
  const expectedFingerprint = semanticConfigurationFingerprint(configuration);
  if (
    receipt.semantic?.fingerprint !== expectedFingerprint
    || receipt.semantic.revision !== 1
    || JSON.stringify(receipt).includes('qualification-profile-not-a-usable-api-key')
    || JSON.stringify(receipt).includes('127.0.0.1:9')
    || JSON.stringify(receipt).includes('text-embedding-3-small')
  ) throw new Error(`${vectorKind} semantic receipt leaked configuration or did not match its fingerprint`);
  const token = (await readFile(receipt.protectedTokenFile.canonicalPath, 'utf8')).trim();
  const response = await fetch(`http://127.0.0.1:${semanticPort}/health/ready`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const status = await response.json();
  if (
    !response.ok
    || status.semanticState?.state !== 'degraded'
    || status.semanticState?.configured !== true
    || status.semanticState?.revision !== 1
    || status.semanticState?.fingerprint !== expectedFingerprint
    || status.semanticState?.ready !== false
  ) throw new Error(`${vectorKind} semantic authenticated readiness was not truthful`);
  const services = (await composeCommand(semanticProjectName, semanticComposeDirectory, ['ps', '--all', '--format', 'json']))
    .stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line).Service);
  if (services.includes('ollama') || (qdrant && !services.includes('qdrant'))) {
    throw new Error(`${vectorKind} semantic Compose capability reporting is invalid`);
  }
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
      profiles: input.profiles ?? lock.compose.profiles,
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

async function verifyWaystoneAssets(workshopPort, token) {
  const manifest = JSON.parse(await readFile(join(root, 'components', 'waystone', 'waystone-assets.json'), 'utf8'));
  const expected = manifest.files.find((file) => file.path === manifest.entrypoint);
  if (!expected) throw new Error('Waystone entrypoint is absent from the exact manifest');
  for (const pathname of ['/app', `/app/${manifest.entrypoint}`]) {
    const response = await fetch(`http://127.0.0.1:${workshopPort}${pathname}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (
      !response.ok
      || bytes.byteLength !== expected.bytes
      || createHash('sha256').update(bytes).digest('hex') !== expected.sha256
      || response.headers.get('content-type') !== expected.mediaType
    ) throw new Error(`Waystone asset ${pathname} did not match its immutable manifest`);
  }
  const rootResponse = await fetch(`http://127.0.0.1:${workshopPort}/`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (rootResponse.ok) throw new Error('Waystone static prefix shadowed the Workshop root');
  const traversal = await fetch(`http://127.0.0.1:${workshopPort}/app/%2e%2e%2fmcp`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (traversal.ok) throw new Error('Waystone static prefix accepted an encoded traversal');
  await callMcp(workshopPort, token, 'gnolith_status', {});
}

async function assertRepairDiagnosis(control, selector, operationId, token) {
  const diagnosis = await control.diagnose(selector);
  if (
    diagnosis.classification !== 'local-workshop-unavailable'
    || diagnosis.restartAllowed !== true
    || diagnosis.repair?.kind !== 'seedbed-resume-operation-v1'
    || diagnosis.repair.operationId !== operationId
    || diagnosis.repair.action !== 'restart-recorded-compose'
  ) throw new Error(`stopped Workshop did not produce the exact bounded repair: ${JSON.stringify(diagnosis)}`);
  if (JSON.stringify(diagnosis).includes(token)) throw new Error('diagnosis exposed the protected bearer value');
}

async function assertAuthenticatedReady(workshopPort, token) {
  const response = await fetch(`http://127.0.0.1:${workshopPort}/health/ready`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('resumed Workshop did not regain authenticated readiness');
  const status = await response.json();
  if (status.operationCatalogDigest !== lock.migrations.expectedCatalogDigest) {
    throw new Error('resumed Workshop catalog differs from the exact component lock');
  }
}

async function assertSingleWorkshopContainer(name, directory) {
  const result = await composeCommand(name, directory, ['ps', '--all', '--format', 'json']);
  const services = result.stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  if (services.filter((entry) => entry.Service === 'workshop').length !== 1) {
    throw new Error('resume created a duplicate Workshop container or project');
  }
}

async function callMcp(workshopPort, token, name, args) {
  const response = await fetch(`http://127.0.0.1:${workshopPort}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-03-26',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${name}-${key}`,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json();
  if (!response.ok || body.error || body.result?.isError === true) {
    throw new Error(`Workshop MCP ${name} failed: ${JSON.stringify(body).slice(0, 1024)}`);
  }
  return body.result;
}

async function composeCommand(name, directory, args) {
  return exec('docker', [
    'compose', '--project-name', name,
    '--file', join(directory, 'compose.yaml'),
    '--env-file', join(directory, 'compose.env'),
    ...args,
  ], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
}

async function installPackedSeedbed() {
  if (!process.env.npm_execpath) throw new Error('Docker qualification must run through npm');
  const artifacts = join(temporaryRoot, 'packed-artifacts');
  const project = join(temporaryRoot, 'packed-cli');
  await mkdir(artifacts, { recursive: true });
  await mkdir(project, { recursive: true });
  const packed = await exec(process.execPath, [
    process.env.npm_execpath,
    'pack', '--json', '--ignore-scripts', '--pack-destination', artifacts,
  ], { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const metadata = JSON.parse(packed.stdout);
  const archive = join(artifacts, metadata[0].filename);
  await exec(process.execPath, [process.env.npm_execpath, 'init', '--yes'], {
    cwd: project, windowsHide: true, maxBuffer: 1024 * 1024,
  });
  await exec(process.execPath, [process.env.npm_execpath, 'install', '--ignore-scripts', archive], {
    cwd: project, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  const installedRoot = join(project, 'node_modules', '@gnolith', 'seedbed');
  return {
    project,
    root: installedRoot,
    cli: join(installedRoot, 'dist', 'cli.js'),
  };
}

async function runPackedCli(cli, args) {
  const result = await exec(process.execPath, [cli, ...args], {
    cwd: dirname(cli),
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
}

async function expectPackedCliFailure(cli, args) {
  try {
    await runPackedCli(cli, args);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 2) return;
    throw error;
  }
  throw new Error('tampered packed backup unexpectedly verified');
}

async function snapshotVolume(volume) {
  const program = String.raw`
    const { createHash } = require('node:crypto');
    const { readdirSync, readFileSync, statSync } = require('node:fs');
    const { join, relative } = require('node:path');
    const root = '/data';
    const files = [];
    function visit(directory) {
      for (const name of readdirSync(directory).sort()) {
        const path = join(directory, name);
        const metadata = statSync(path);
        if (metadata.isDirectory()) visit(path);
        else if (metadata.isFile()) {
          const bytes = readFileSync(path);
          files.push({
            path: relative(root, path).replaceAll('\\', '/'),
            bytes: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          });
        } else throw new Error('unsupported volume entry');
      }
    }
    visit(root);
    process.stdout.write(JSON.stringify({ files }));
  `;
  const result = await exec('docker', [
    'run', '--rm', '--network', 'none', '--read-only',
    '--volume', `${volume}:/data:ro`,
    lock.compose.nodeImage,
    'node', '--eval', program,
  ], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(result.stdout);
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

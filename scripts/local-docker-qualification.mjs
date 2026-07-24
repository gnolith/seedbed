import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import {
  decodeCanonicalTextSecret,
  digestObject,
  semanticConfigurationFingerprint,
  validateConfig,
} from '../dist/index.js';
import { createOperatorOwnerPorts } from '../dist/owner-ports.js';
import { DockerComposeDriver } from '../dist/system-drivers.js';

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
  const control = packedControl.createSeedbedControl(basePolicy);
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
  const token = decodeCanonicalTextSecret(await readFile(receipt.protectedTokenFile.canonicalPath), 45);
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
  const protectedFixtureReceipt = join(temporaryRoot, 'protected-backup-fixture-receipt.json');
  const populated = await exec(process.execPath, [
    join(root, 'scripts', 'populate-public-backup-fixture.mjs'),
    `http://127.0.0.1:${port}`,
    '--token-file',
    receipt.protectedTokenFile.canonicalPath,
    '--receipt-file',
    protectedFixtureReceipt,
  ], { windowsHide: true, maxBuffer: 1024 * 1024 });
  const populatedReceipt = JSON.parse(populated.stdout);
  if (
    populatedReceipt.format !== 'gnolith-workshop-public-backup-fixture-v1'
    || JSON.stringify(populatedReceipt).includes(token)
  ) throw new Error('public MCP backup fixture was not created opaquely');
  await callMcp(port, token, 'create_item', {
    idempotencyKey: `seedbed-backup-populated-${key}`,
    authoredText: 'Seedbed populated backup verification fixture',
    data: {
      id: 'Q900001',
      labels: { en: { language: 'en', value: 'Seedbed populated fixture' } },
    },
  });
  const taskIdempotencyKey = `seedbed-task-create-${key}`;
  const completionIdempotencyKey = `seedbed-task-complete-${key}`;
  const createdTask = (await callMcp(port, token, 'create_task', {
    idempotencyKey: taskIdempotencyKey,
    description: 'Seedbed exact restore task',
    prompt: 'Prove claimed, completed, and idempotently replayed task restore.',
  })).structuredContent;
  const claimedTask = (await callMcp(port, token, 'claim_task', {
    taskId: createdTask.id,
  })).structuredContent;
  const completionInput = {
    taskId: createdTask.id,
    leaseToken: claimedTask.leaseToken,
    expectedRevision: claimedTask.task.revision,
    idempotencyKey: completionIdempotencyKey,
    result: 'Seedbed restore qualification completed',
    outcomeKind: 'success',
  };
  const completedTask = (await callMcp(port, token, 'complete_task', completionInput)).structuredContent;
  const replayedCompletion = (await callMcp(port, token, 'complete_task', completionInput)).structuredContent;
  if (digestObject(completedTask) !== digestObject(replayedCompletion)) {
    throw new Error(`task completion did not replay idempotently before backup: ${JSON.stringify({
      completedTask,
      replayedCompletion,
    }).slice(0, 2048)}`);
  }
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

  if (process.env.SEEDBED_BACKUP_DIAGNOSTIC_ONLY !== '1') {
    const selector = { installationId, projectRoot: packed.project };
    await composeCommand(projectName, composeDirectory, ['stop', 'workshop']);
    await assertRepairDiagnosis(control, selector, receipt.operationId, token, projectName);
    await boundedResume(control, receipt.operationId);
    await assertAuthenticatedReady(port, token);
    await boundedResume(control, receipt.operationId);
    await assertSingleWorkshopContainer(projectName, composeDirectory);

    const workshopContainer = `${projectName}-workshop-1`;
    await exec('docker', ['kill', workshopContainer], { windowsHide: true, maxBuffer: 1024 * 1024 });
    await assertRepairDiagnosis(control, selector, receipt.operationId, token, projectName);
    await boundedResume(control, receipt.operationId);
    await assertAuthenticatedReady(port, token);

    await composeCommand(projectName, composeDirectory, ['down', '--remove-orphans']);
    await assertRepairDiagnosis(control, selector, receipt.operationId, token, projectName);
    await boundedResume(control, receipt.operationId);
    await assertAuthenticatedReady(port, token);
    await assertSingleWorkshopContainer(projectName, composeDirectory);
  }

  const sourceConfig = installationConfig({
    installationId,
    baseIri: request.baseIri,
    projectName,
    dataVolume: `${projectName}-data`,
    stateDirectory: join(stateRoot, 'installations', key),
    tokenFile: receipt.protectedTokenFile.canonicalPath,
    port,
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
  });
  const compatibilityConfigPath = join(packed.project, 'compatibility-config.json');
  const compatibilityPlanPath = join(packed.project, 'compatibility-plan.json');
  await writeFile(compatibilityConfigPath, `${JSON.stringify(compatibilityConfig, null, 2)}\n`);
  await runPackedCli(packed.cli, ['plan', '--config', compatibilityConfigPath, '--out', compatibilityPlanPath]);
  await runPackedCli(packed.cli, ['apply', '--config', compatibilityConfigPath, '--plan', compatibilityPlanPath]);
  await composeCommand(compatibilityProjectName, compatibilityComposeDirectory, ['stop', 'workshop']);
  const beforeDryRun = await snapshotVolume(`${compatibilityProjectName}-data`);
  await runPackedCli(packed.cli, ['backup', 'restore', '--config', compatibilityConfigPath, '--archive', backupPath, '--dry-run']);
  if (JSON.stringify(await snapshotVolume(`${compatibilityProjectName}-data`)) !== JSON.stringify(beforeDryRun)) {
    throw new Error('packed backup dry-run changed its stopped compatibility target');
  }

  const restoreTokenFile = join(restoreState, 'secrets', 'bearer');
  await mkdir(join(restoreState, 'secrets'), { recursive: true });
  await writeFile(restoreTokenFile, token, { encoding: 'utf8', mode: 0o600 });
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
  const restoreConfigPath = join(packed.project, 'restore-config.json');
  await writeFile(
    restoreConfigPath,
    `${JSON.stringify(restoreConfig, null, 2)}\n`,
  );
  await expectPackedCliFailure(packed.cli, [
    'backup', 'restore',
    '--config', restoreConfigPath,
    '--archive', tamperedPath,
  ]);
  await assertRestoreTargetAbsent(
    restoreProjectName,
    `${restoreProjectName}-data`,
  );
  await runPackedCli(packed.cli, [
    'backup', 'restore',
    '--config', restoreConfigPath,
    '--archive', backupPath,
  ]);
  const restoreDriver = new DockerComposeDriver(root);
  const restorePorts = createOperatorOwnerPorts(restoreConfig, restoreDriver);
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
  await restoreDriver.up(restoreConfig);
  const restoredTask = (await callMcp(restoreConfig.compose.workshopPort, token, 'get_task', {
    taskId: createdTask.id,
  })).structuredContent;
  if (
    restoredTask.id !== completedTask.id
    || restoredTask.result !== completedTask.result
    || restoredTask.claimed !== false
  ) throw new Error('restored claimed/completed task did not match the exact pre-backup state');
  const restoredReplay = (await callMcp(
    restoreConfig.compose.workshopPort,
    token,
    'complete_task',
    completionInput,
  )).structuredContent;
  if (digestObject(restoredReplay) !== digestObject(completedTask)) {
    throw new Error('restored task completion idempotency replay did not match the original result');
  }
  const verifiedFixture = await exec(process.execPath, [
    join(root, 'scripts', 'verify-public-backup-fixture.mjs'),
    `http://127.0.0.1:${restoreConfig.compose.workshopPort}`,
    '--token-file',
    restoreTokenFile,
    protectedFixtureReceipt,
  ], { windowsHide: true, maxBuffer: 1024 * 1024 });
  const fixtureVerification = JSON.parse(verifiedFixture.stdout);
  if (
    fixtureVerification.format !== 'gnolith-workshop-public-backup-verification-v1'
    || JSON.stringify(fixtureVerification).includes(token)
  ) throw new Error('restored public backup fixture did not verify opaquely');
  console.log('qualifying semantic SQLite profile');
  await verifySemanticProfile(packed, 'sqlite');
  console.log('qualifying semantic Qdrant profile');
  await verifySemanticProfile(packed, 'qdrant');
  console.log('qualifying unreachable semantic profile');
  await verifyUnavailableSemanticProfile(packed);
  console.log('verified exact pinned local Docker graph, repair, backup/restore, protected OpenAI semantic configuration, SQLite, and Qdrant');
} finally {
  for (const cleanup of semanticCleanups) {
    if (cleanup.mockContainer) {
      await exec('docker', ['rm', '--force', cleanup.mockContainer], {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }).catch(() => undefined);
    }
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
  const mockContainer = `${semanticProjectName}-mock-provider`;
  const mockPort = await availablePort();
  semanticCleanups.push({
    projectName: semanticProjectName,
    composeDirectory: semanticComposeDirectory,
    dataVolume: `${semanticProjectName}-data`,
    mockContainer,
    ...(qdrant ? { qdrantVolume: `${semanticProjectName}-qdrant` } : {}),
  });
  const control = packedControl.createSeedbedControl({
    ...policy,
    compose: {
      ...policy.compose,
      profiles: qdrant ? ['waystone', 'qdrant'] : ['waystone'],
    },
  });
  await startSemanticMock(policy.compose.nodeImage, mockContainer, mockPort);
  await assertHostGatewayMockReachable(policy.compose.nodeImage, mockPort);
  const configuration = {
    version: 1,
    id: `qualification-${vectorKind}`,
    name: `Qualification ${vectorKind}`,
    provider: {
      kind: 'openai-compatible',
      endpoint: `http://127.0.0.1:${mockPort}/v1/embeddings`,
      allowPrivateEndpoint: true,
      model: 'text-embedding-3-small',
      dimensions: 8,
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
      semanticState: 'ready',
      allowLexicalOnly: false,
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
  const semanticPlan = await control.plan(request);
  if (semanticPlan.request.semantic?.configuration.provider.endpoint !== `http://host.docker.internal:${mockPort}/v1/embeddings`) {
    throw new Error(`${vectorKind} semantic plan did not expose the pinned host-gateway mapping`);
  }
  const receipt = await control.apply(semanticPlan);
  const expectedFingerprint = semanticConfigurationFingerprint(semanticPlan.request.semantic.configuration);
  if (
    receipt.semantic?.fingerprint !== expectedFingerprint
    || receipt.semantic.revision !== 1
    || receipt.semantic.state !== 'ready'
    || receipt.semanticApproval?.kind !== 'workshop-semantic-plan-approval-v1'
    || receipt.semanticApproval.configurationId !== configuration.id
    || typeof receipt.semanticApproval.planId !== 'string'
    || !/^[0-9a-f]{64}$/u.test(receipt.semanticApproval.estimateDigest)
    || JSON.stringify(receipt).includes('qualification-profile-not-a-usable-api-key')
    || JSON.stringify(receipt).includes('host.docker.internal')
    || JSON.stringify(receipt).includes('text-embedding-3-small')
  ) throw new Error(`${vectorKind} semantic receipt leaked configuration or did not match its fingerprint`);
  const persistedReceipt = JSON.parse(await readFile(
    join(semanticStateRoot, 'installations', semanticKey, 'installation-receipt.json'),
    'utf8',
  ));
  if (
    persistedReceipt.semantic?.state !== 'ready'
    || persistedReceipt.semantic?.fingerprint !== expectedFingerprint
    || digestObject(persistedReceipt.semanticApproval) !== digestObject(receipt.semanticApproval)
    || JSON.stringify(persistedReceipt).includes('/v1/embeddings')
  ) throw new Error(`${vectorKind} persisted semantic receipt was not finalized safely`);
  const token = decodeCanonicalTextSecret(await readFile(receipt.protectedTokenFile.canonicalPath), 45);
  const response = await fetch(`http://127.0.0.1:${semanticPort}/health/ready`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const status = await response.json();
  if (
    !response.ok
    || status.semanticState?.state !== 'ready'
    || status.semanticState?.configured !== true
    || status.semanticState?.revision !== 1
    || status.semanticState?.fingerprint !== expectedFingerprint
    || status.semanticState?.ready !== true
    || status.semanticState?.diagnostic !== null
  ) throw new Error(`${vectorKind} semantic authenticated readiness was not truthful`);
  const services = (await composeCommand(semanticProjectName, semanticComposeDirectory, ['ps', '--all', '--format', 'json']))
    .stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line).Service);
  if (services.includes('ollama') || (qdrant && !services.includes('qdrant'))) {
    throw new Error(`${vectorKind} semantic Compose capability reporting is invalid`);
  }
  const semanticEntityId = vectorKind === 'qdrant' ? 'Q900011' : 'Q900010';
  const deniedEntityId = vectorKind === 'qdrant' ? 'Q900013' : 'Q900012';
  await callMcp(semanticPort, token, 'create_item', {
    idempotencyKey: `semantic-${vectorKind}-${key}`,
    authoredText: `Semantic ${vectorKind} qualification`,
    data: {
      id: semanticEntityId,
      labels: { en: { language: 'en', value: `Semantic ${vectorKind} lighthouse` } },
    },
  });
  const deniedEntity = await callMcp(semanticPort, token, 'create_item', {
    idempotencyKey: `semantic-denied-${vectorKind}-${key}`,
    authoredText: `Semantic ${vectorKind} authorization fixture`,
    data: {
      id: deniedEntityId,
      labels: { en: { language: 'en', value: `Restricted semantic ${vectorKind} lighthouse` } },
    },
  });
  const authorization = await callMcp(semanticPort, token, 'authorization_admin', {
    version: 1,
    action: 'status',
  });
  let policyRevision = authorization.structuredContent?.policyRevision;
  if (!Number.isSafeInteger(policyRevision)) {
    throw new Error(`${vectorKind} authorization status did not expose a bounded policy revision`);
  }
  const ownerStatus = (await callMcp(semanticPort, token, 'gnolith_status', {})).structuredContent;
  const ownerPrincipalId = ownerStatus?.principalId;
  const workspaceId = ownerStatus?.activeWorkspaceId;
  if (typeof ownerPrincipalId !== 'string' || typeof workspaceId !== 'string') {
    throw new Error(`${vectorKind} owner authorization context was unavailable`);
  }
  const deniedTargetRevision = deniedEntity.structuredContent?.newRevision;
  if (!Number.isSafeInteger(deniedTargetRevision)) {
    throw new Error(`${vectorKind} denied fixture did not expose its target revision`);
  }
  const callers = {};
  for (const label of ['reader', 'outsider']) {
    const principalId = `semantic-${label}-${vectorKind}-${key}`;
    const credentialId = `semantic-${label}-credential-${vectorKind}-${key}`;
    const tokenBytes = createHash('sha256')
      .update(`seedbed-semantic-${label}-v1\0${vectorKind}\0${key}`, 'utf8')
      .digest();
    const callerToken = tokenBytes.toString('base64url');
    const tokenDigest = createHash('sha256')
      .update(Buffer.from('gnolith-local-bearer-v1\0', 'utf8'))
      .update(tokenBytes)
      .digest('hex');
    for (const [suffix, input] of [
      ['principal', {
        action: 'principal-create',
        principal: { principalId, enabled: true },
      }],
      ['membership', {
        action: 'workspace-membership-add',
        principalId,
        workspaceId,
      }],
      ['read-grant', {
        action: 'workspace-grant-add',
        principalId,
        workspaceId,
        capability: 'read',
      }],
      ['credential', {
        action: 'credential-register',
        credential: {
          credentialId,
          tokenDigest,
          principalId,
          workspaceId,
        },
      }],
    ]) {
      const administration = await callMcp(semanticPort, token, 'authorization_admin', {
        version: 1,
        expectedPolicyRevision: policyRevision,
        idempotencyKey: `semantic-${label}-${suffix}-${vectorKind}-${key}`,
        ...input,
      });
      policyRevision = administration.structuredContent?.policyRevision;
      if (!Number.isSafeInteger(policyRevision)) {
        throw new Error(`${vectorKind} ${label} ${suffix} did not advance policy revision`);
      }
    }
    callers[label] = { principalId, token: callerToken };
  }
  await callMcp(semanticPort, token, 'authorization_admin', {
    version: 1,
    action: 'visibility-policy-set',
    expectedPolicyRevision: policyRevision,
    idempotencyKey: `semantic-visibility-${vectorKind}-${key}`,
    target: { kind: 'entity', id: deniedEntityId },
    expectedTargetRevision: deniedTargetRevision,
    visibility: {
      version: 1,
      clauses: [[
        { kind: 'principal', principalId: ownerPrincipalId },
        { kind: 'principal', principalId: callers.reader.principalId },
      ]],
    },
  });
  await approveSemanticFixturePlan(
    semanticPort,
    token,
    receipt.semanticApproval.configurationId,
    vectorKind,
  );
  await waitForSemanticOnlySearch(
    semanticPort, callers.reader.token, semanticEntityId, deniedEntityId, vectorKind, true,
  );
  await waitForSemanticOnlySearch(
    semanticPort, callers.outsider.token, semanticEntityId, deniedEntityId, vectorKind, false,
  );
  await composeCommand(semanticProjectName, semanticComposeDirectory, ['restart', 'workshop']);
  await assertAuthenticatedReady(semanticPort, token);
  await waitForSemanticOnlySearch(
    semanticPort, callers.reader.token, semanticEntityId, deniedEntityId, vectorKind, true,
  );
  await waitForSemanticOnlySearch(
    semanticPort, callers.outsider.token, semanticEntityId, deniedEntityId, vectorKind, false,
  );
  const plansBeforeReplay = await semanticPlanIdentities(semanticPort, token);
  const replay = await control.resume(receipt.operationId);
  if (
    digestObject(replay.semanticApproval) !== digestObject(receipt.semanticApproval)
    || replay.semantic?.state !== 'ready'
  ) throw new Error(`${vectorKind} semantic approval did not replay idempotently`);
  const plansAfterReplay = await semanticPlanIdentities(semanticPort, token);
  if (digestObject(plansAfterReplay) !== digestObject(plansBeforeReplay)) {
    throw new Error(`${vectorKind} semantic approval replay created a duplicate owner plan`);
  }
}

async function verifyUnavailableSemanticProfile(packed) {
  const packedControl = await import(pathToFileURL(join(packed.root, 'dist', 'local-control.js')).href);
  const semanticInstallationId = `${installationId}-semantic-unreachable`;
  const semanticKey = digestObject(semanticInstallationId).slice(0, 24);
  const semanticProjectName = `gnolith-${semanticKey}`;
  const semanticStateRoot = join(temporaryRoot, 'semantic-unreachable-state');
  const semanticComposeDirectory = join(semanticStateRoot, 'installations', semanticKey, 'compose');
  const semanticPort = await availablePort();
  const unavailableProviderPort = await availablePort();
  const providerSelectorPath = join(semanticStateRoot, 'protected', 'openai-profile');
  await mkdir(dirname(providerSelectorPath), { recursive: true });
  await writeFile(providerSelectorPath, 'qualification-profile-not-a-usable-api-key\n', { encoding: 'utf8', mode: 0o600 });
  await chmod(providerSelectorPath, 0o600);
  const policy = packedControl.defaultSeedbedControlPolicy({
    projectRoot: packed.project,
    stateRoot: semanticStateRoot,
    artifactRoot: packed.root,
  });
  semanticCleanups.push({
    projectName: semanticProjectName,
    composeDirectory: semanticComposeDirectory,
    dataVolume: `${semanticProjectName}-data`,
  });
  const control = packedControl.createSeedbedControl({
    ...policy,
    compose: {
      ...policy.compose,
      profiles: ['waystone'],
    },
  });
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
      configuration: {
        version: 1,
        id: 'qualification-unreachable',
        name: 'Qualification unreachable provider',
        provider: {
          kind: 'openai-compatible',
          endpoint: `http://127.0.0.1:${unavailableProviderPort}/v1/embeddings`,
          allowPrivateEndpoint: true,
          model: 'text-embedding-3-small',
          dimensions: 8,
          metric: 'cosine',
          credentialSelector: 'openai-profile',
          redirectPolicy: 'error',
        },
        vector: { kind: 'sqlite' },
      },
      expectedRevision: 0,
      credentialSelectors: [{
        id: 'openai-profile',
        kind: 'protected-file-v1',
        path: providerSelectorPath,
      }],
    },
  };
  const plan = await control.plan(request);
  if (plan.request.semantic?.configuration.provider.endpoint !== `http://host.docker.internal:${unavailableProviderPort}/v1/embeddings`) {
    throw new Error('unreachable semantic plan did not retain the exact full host-gateway POST endpoint');
  }
  const receipt = await control.apply(plan);
  const receiptText = JSON.stringify(receipt);
  if (
    receipt.semantic?.state !== 'degraded'
    || receipt.semantic?.revision !== 1
    || receipt.semanticApproval !== undefined
    || receiptText.includes('qualification-profile-not-a-usable-api-key')
    || receiptText.includes('/v1/embeddings')
    || receiptText.includes('host.docker.internal')
  ) throw new Error('unreachable semantic receipt leaked endpoint or protected credential material');
  const persistedReceipt = JSON.parse(await readFile(
    join(semanticStateRoot, 'installations', semanticKey, 'installation-receipt.json'),
    'utf8',
  ));
  if (
    persistedReceipt.semantic?.state !== 'degraded'
    || JSON.stringify(persistedReceipt).includes('/v1/embeddings')
    || JSON.stringify(persistedReceipt).includes('qualification-profile-not-a-usable-api-key')
  ) throw new Error('unreachable persisted semantic receipt was not finalized safely');
  const token = decodeCanonicalTextSecret(await readFile(receipt.protectedTokenFile.canonicalPath), 45);
  await assertDegradedSemanticStatus(semanticPort, token, unavailableProviderPort);
  const workshopContainer = `${semanticProjectName}-workshop-1`;
  const restartPolicy = await exec('docker', [
    'inspect', '--format', '{{json .HostConfig.RestartPolicy}}', workshopContainer,
  ], { windowsHide: true, maxBuffer: 1024 * 1024 });
  const restart = JSON.parse(restartPolicy.stdout);
  if (restart.Name !== 'no' || restart.MaximumRetryCount !== 0) {
    throw new Error(`unreachable semantic Workshop restart policy is unsafe: ${restartPolicy.stdout.trim()}`);
  }
  await callMcp(semanticPort, token, 'create_item', {
    idempotencyKey: `semantic-unreachable-lexical-${key}`,
    authoredText: 'Lexical fallback qualification',
    data: {
      id: 'Q900014',
      labels: { en: { language: 'en', value: 'Lexical fallback marigold' } },
    },
  });
  await waitForLexicalSearch(semanticPort, token, 'Q900014', 'marigold');
  await composeCommand(semanticProjectName, semanticComposeDirectory, ['restart', 'workshop']);
  await assertDegradedSemanticStatus(semanticPort, token, unavailableProviderPort);
  await waitForLexicalSearch(semanticPort, token, 'Q900014', 'marigold');
  const inspect = await exec('docker', [
    'inspect', '--format', '{{.RestartCount}}', workshopContainer,
  ], { windowsHide: true, maxBuffer: 1024 * 1024 });
  if (Number(inspect.stdout.trim()) !== 0) {
    throw new Error('explicit restart was followed by an automatic Workshop restart loop');
  }
}

async function semanticPlanIdentities(workshopPort, token) {
  const health = await callMcp(workshopPort, token, 'search_admin', { action: 'health' });
  return (health.structuredContent?.semantic?.plans ?? health.structuredContent?.plans ?? [])
    .map((plan) => ({ planId: plan.planId, state: plan.state }))
    .sort((left, right) => String(left.planId).localeCompare(String(right.planId)));
}

async function approveSemanticFixturePlan(workshopPort, token, configurationId, vectorKind) {
  const deadline = Date.now() + 90_000;
  while (true) {
    await callMcp(workshopPort, token, 'search_admin', {
      action: 'materialize',
      limit: 100,
      options: { maxRebuildRoots: 100 },
    });
    const health = (await callMcp(
      workshopPort, token, 'search_admin', { action: 'health' },
    )).structuredContent;
    const source = health?.materialization?.sourceHighWatermark;
    const applied = health?.materialization?.activeAppliedWatermark;
    if (
      Number.isSafeInteger(source)
      && Number.isSafeInteger(applied)
      && source === applied
    ) break;
    if (Date.now() >= deadline) {
      throw new Error(`${vectorKind} fixture materialization did not reach its estimate boundary`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  const estimate = (await callMcp(workshopPort, token, 'search_admin', {
    action: 'semantic-estimate',
    options: {
      configurationId,
      policy: { mode: 'asap', maxBatchesPerRun: 1 },
    },
  })).structuredContent;
  const planId = estimate?.planId;
  if (typeof planId !== 'string' || planId.length === 0 || planId.length > 256) {
    throw new Error(`${vectorKind} fixture semantic estimate did not expose a bounded plan ID`);
  }
  await callMcp(workshopPort, token, 'search_admin', {
    action: 'semantic-approve',
    options: { planId },
  });
}

async function assertDegradedSemanticStatus(workshopPort, token, unavailableProviderPort) {
  const deadline = Date.now() + 60_000;
  let last = '';
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${workshopPort}/health/ready`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(async () => {
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      return undefined;
    });
    if (response === undefined) continue;
    const status = await response.json();
    const serialized = JSON.stringify(status);
    last = serialized;
    const diagnostic = status.semanticState?.diagnostic;
    const safeDegraded = (
      response.status === 503
      && status.lexicalReady === true
      && status.semanticState?.state === 'degraded'
      && status.semanticState?.configured === true
      && status.semanticState?.ready === false
      && diagnostic?.retryable === true
      && diagnostic?.format === 'gnolith-workshop-semantic-diagnostic-v1'
      && diagnostic?.version === 1
      && diagnostic?.backend === 'sqlite'
      && diagnostic?.repair === 'retry'
      && Object.keys(diagnostic).sort().join(',') === 'backend,code,format,repair,retryable,version'
      && serialized.length <= 65_536
      && !serialized.includes('qualification-profile-not-a-usable-api-key')
      && !serialized.includes(`:${unavailableProviderPort}`)
      && !serialized.includes('/v1/embeddings')
    );
    if (!safeDegraded) {
      throw new Error(`unreachable semantic status was not bounded, actionable, secret-safe, and lexical-ready: ${serialized.slice(0, 2048)}`);
    }
    if (diagnostic.code === 'provider-unavailable') return;
    if (diagnostic.code !== 'materialization-pending') {
      throw new Error(`unreachable semantic status exposed an unsupported diagnostic: ${serialized.slice(0, 2048)}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`unreachable semantic status did not settle to provider-unavailable: ${last.slice(0, 2048)}`);
}

async function waitForLexicalSearch(workshopPort, token, entityId, text) {
  const deadline = Date.now() + 60_000;
  let last;
  while (Date.now() < deadline) {
    await callMcp(workshopPort, token, 'search_admin', { action: 'materialize', limit: 100 }).catch(() => undefined);
    last = await callMcp(workshopPort, token, 'search', {
      text,
      kinds: ['item'],
      limit: 10,
    }).catch(() => undefined);
    if (last?.structuredContent?.items?.some((result) => result.id === entityId || result.sourceId === entityId)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`lexical fallback search did not remain available: ${JSON.stringify(last).slice(0, 1024)}`);
}

async function startSemanticMock(nodeImage, containerName, hostPort) {
  const server = [
    "const http=require('node:http')",
    "http.createServer((req,res)=>{",
    "if(req.method!=='POST'||req.url!=='/v1/embeddings'||req.headers.authorization!=='Bearer qualification-profile-not-a-usable-api-key'){res.writeHead(403);return res.end()}",
    "let body='';req.on('data',c=>body+=c);req.on('end',()=>{",
    "const value=JSON.parse(body);const input=Array.isArray(value.input)?value.input:[];const dimensions=value.dimensions;",
    "if(!Number.isInteger(dimensions)||dimensions<1||input.length<1){res.writeHead(400);return res.end()}",
    "const data=input.map((text,index)=>{const semantic=/lighthouse|beacon/iu.test(String(text));const slot=semantic?0:1;return {index,embedding:Array.from({length:dimensions},(__,dimension)=>dimension===slot?1:0)}});",
    "const encoded=JSON.stringify({object:'list',data,model:value.model,usage:{prompt_tokens:input.length,total_tokens:input.length}});",
    "res.writeHead(200,{'content-type':'application/json','content-length':Buffer.byteLength(encoded)});res.end(encoded)",
    "})}).listen(8787,'0.0.0.0')",
  ].join(';');
  await exec('docker', [
    'run', '--detach', '--rm',
    '--name', containerName,
    '--publish', `127.0.0.1:${hostPort}:8787`,
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    nodeImage,
    'node', '-e', server,
  ], { windowsHide: true, maxBuffer: 1024 * 1024 });
}

async function assertHostGatewayMockReachable(nodeImage, hostPort) {
  const endpoint = `http://host.docker.internal:${hostPort}/v1/embeddings`;
  await exec('docker', [
    'run', '--rm',
    '--add-host', 'host.docker.internal:host-gateway',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    nodeImage,
    'node', '-e',
    "fetch(process.argv[1],{method:'POST',headers:{authorization:'Bearer qualification-profile-not-a-usable-api-key','content-type':'application/json'},body:JSON.stringify({model:'text-embedding-3-small',dimensions:8,input:['host gateway probe']})}).then(async r=>{if(r.status!==200)throw new Error('mock status '+r.status);const v=await r.json();if(!Array.isArray(v.data)||v.data.length!==1)throw new Error('mock body')})",
    endpoint,
  ], { windowsHide: true, maxBuffer: 1024 * 1024 });
}

async function waitForSemanticOnlySearch(
  workshopPort,
  token,
  entityId,
  deniedEntityId,
  vectorKind,
  expectRestricted,
) {
  const deadline = Date.now() + 90_000;
  let last;
  while (Date.now() < deadline) {
    await callMcp(workshopPort, token, 'search_admin', { action: 'materialize', limit: 100 }).catch(() => undefined);
    last = await callMcp(workshopPort, token, 'search', {
      text: 'beacon',
      kinds: ['item'],
      limit: 10,
    }).catch(() => undefined);
    const items = last?.structuredContent?.items ?? [];
    const visible = items.find((result) => result.id === entityId || result.sourceId === entityId);
    const restricted = items.find(
      (result) => result.id === deniedEntityId || result.sourceId === deniedEntityId,
    );
    if (
      visible
      && Boolean(restricted) === expectRestricted
      && Number(visible.score) > 0
      && Number(visible.score) < 0.02
    ) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`${vectorKind} semantic-only authorization-filtered search did not return the isolated mock-provider fixture: ${JSON.stringify(last).slice(0, 1024)}`);
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
  // A Qdrant-only profile can survive `compose down` after the Workshop
  // service is removed during restart qualification. The generated project
  // name is digest-bounded, so clean up only that exact owned fallback.
  await exec('docker', ['rm', '--force', `${name}-qdrant-1`], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
  await exec('docker', ['volume', 'rm', volume], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
  await exec('docker', ['network', 'rm', name], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
}

async function verifyWaystoneAssets(workshopPort, token) {
  const manifest = JSON.parse(await readFile(join(root, 'components', 'waystone', 'waystone-assets.json'), 'utf8'));
  const expected = manifest.files.find((file) => file.path === manifest.entrypoint);
  if (!expected) throw new Error('Waystone entrypoint is absent from the exact manifest');
  for (const pathname of ['/app', '/app/', `/app/${manifest.entrypoint}`]) {
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

async function assertRepairDiagnosis(control, selector, operationId, token, composeProject) {
  const started = Date.now();
  const diagnosis = await control.diagnose(selector);
  const elapsedMs = Date.now() - started;
  if (elapsedMs > 10_000) throw new Error(`stopped Workshop diagnosis exceeded 10 seconds (${elapsedMs}ms)`);
  if (
    diagnosis.classification !== 'local-workshop-unavailable'
    || diagnosis.restartAllowed !== true
    || diagnosis.repair?.kind !== 'seedbed-resume-operation-v1'
    || diagnosis.repair.operationId !== operationId
    || diagnosis.repair.action !== 'restart-recorded-compose'
  ) throw new Error(`stopped Workshop did not produce the exact bounded repair: ${JSON.stringify(diagnosis)}`);
  if (JSON.stringify(diagnosis).includes(token)) throw new Error('diagnosis exposed the protected bearer value');
  const operators = await exec('docker', [
    'ps', '--all', '--quiet',
    '--filter', 'name=gnolith-seedbed-op-',
    '--filter', `label=com.docker.compose.project=${composeProject}`,
  ], { windowsHide: true, maxBuffer: 1024 * 1024 });
  if (operators.stdout.trim()) throw new Error('bounded diagnosis left a Seedbed operator child container');
}

async function boundedResume(control, operationId) {
  const started = Date.now();
  const receipt = await control.resume(operationId);
  const elapsedMs = Date.now() - started;
  if (elapsedMs > 60_000) throw new Error(`Seedbed resume exceeded 60 seconds (${elapsedMs}ms)`);
  return receipt;
}

async function assertAuthenticatedReady(workshopPort, token) {
  const deadline = Date.now() + 60_000;
  let lastStatus;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${workshopPort}/health/ready`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      lastStatus = response.status;
      if (response.ok) {
        const status = await response.json();
        if (status.operationCatalogDigest !== lock.migrations.expectedCatalogDigest) {
          throw new Error('resumed Workshop catalog differs from the exact component lock');
        }
        return;
      }
    } catch {
      lastStatus = 'connection-unavailable';
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`resumed Workshop did not regain authenticated readiness: ${String(lastStatus)}`);
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

async function assertRestoreTargetAbsent(projectName, dataVolume) {
  const containers = await exec('docker', [
    'ps', '--all', '--quiet',
    '--filter', `label=com.docker.compose.project=${projectName}`,
  ], { windowsHide: true, maxBuffer: 1024 * 1024 });
  if (containers.stdout.trim()) {
    throw new Error('failed restore created a target container');
  }
  for (const [kind, name] of [
    ['volume', dataVolume],
    ['network', projectName],
  ]) {
    try {
      await exec('docker', [kind, 'inspect', name], {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      throw new Error(`failed restore created target ${kind}`);
    } catch (error) {
      if (
        error instanceof Error
        && error.message === `failed restore created target ${kind}`
      ) throw error;
    }
  }
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

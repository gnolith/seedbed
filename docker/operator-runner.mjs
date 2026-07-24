import { createHash, webcrypto } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  checksumMigration,
  createMigrationAssemblyAuthorityV1,
  createMigrationLedgerBackupV1,
  diamondMigrationNamespace,
  diamondMigrations,
  migrateDiamondStore,
  readAppliedMigrations,
  registerMigrationLedgerOwnerV1,
} from '@gnolith/diamond';
import {
  adoptDiamond041LegacyOwnerV1,
  createDiamondBackupV1,
  decodeDiamond041LegacyOwnerV1,
} from '@gnolith/diamond/backup';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import {
  applyTaprootMigrations,
  createTaprootHostWriteCapability,
  inspectTaprootPersistence,
  planTaprootMigrations,
  taprootMigrationNamespace,
  taprootMigrations,
} from '@gnolith/taproot';
import {
  enumerateResourceBlobDescriptorsV1,
  exportTaprootBackupSectionV1,
  importTaprootBackupSectionV1,
  inspectLegacyTaproot042ForAdoptionV1,
  convertLegacyTaproot042ToBackupSectionV1,
  openVerifiedResourceBlobV1,
  registerTaprootMigrationLedgerOwnerHandleV1,
} from '@gnolith/taproot/backup';
import {
  createLocalFilesystemResourceBlobPortsV1,
  createWorkshopBackupApi,
  createWorkshopLegacyOwnerAdoptionHandleV1,
  createWorkshopOwnerHandlesV1,
  decodeWorkshopLegacyOwnerV042,
  adoptWorkshopLegacyOwnerV042,
} from '@gnolith/workshop/backup';
import {
  applyWorkshopMigrations,
  planWorkshopMigrations,
  workshopNamespacedMigrationsV1,
} from '@gnolith/workshop/migrations';
import { decodeOpaqueOwnerValue, encodeOpaqueOwnerValue } from './opaque-codec.mjs';
import { ReadOnlyPortableSql } from './read-only-sql.mjs';

const exec = promisify(execFile);
const TARGETS = {
  diamond: '0001-current-rdf-schema',
  taproot: '0009-architecture-reset',
  workshop: '9',
};
const VERSIONS = { diamond: '0.5.0', taproot: '0.5.0', workshop: '0.5.0' };
const NAMESPACES = {
  diamond: diamondMigrationNamespace,
  taproot: taprootMigrationNamespace,
  workshop: '@gnolith/workshop',
};
const DIAMOND_LEDGER_API = {
  ensureMigrationLedger: (await import('@gnolith/diamond')).ensureMigrationLedger,
  readAppliedMigrations: (await import('@gnolith/diamond')).readAppliedMigrations,
  applyNamespacedMigrations: (await import('@gnolith/diamond')).applyNamespacedMigrations,
  recordMigrationAdoption: (await import('@gnolith/diamond')).recordMigrationAdoption,
  checksumMigration,
};

const STREAMED = Symbol('streamed');
const operation = process.argv[2];
try {
  if (!operation) throw new TypeError('Seedbed operator operation is required');
  const request = await readRequest();
  const result = await dispatch(operation, request.context, request.input, request);
  if (result !== STREAMED) process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : 'Seedbed operator failed';
  process.stderr.write(`${message.slice(0, 2048).replaceAll(/(?:[A-Za-z]:)?[\\/][^\s"']+/gu, '[redacted-path]')}\n`);
  process.exitCode = 1;
}

async function dispatch(name, context, input, request) {
  assertContext(context);
  switch (name) {
    case 'owner-migration-plan-v1':
      return migrationPlan(context, input);
    case 'owner-migration-apply-v1':
      return applyMigration(context, input);
    case 'owner-diagnostics-v1':
      return ownerDiagnostic(context, assertOwner(input?.owner));
    case 'owner-backup-inspect-v1':
      return inspectOwnerBackup(context, assertOwner(input?.owner));
    case 'owner-backup-export-v1':
      return exportOwnerBackup(context, assertOwner(input?.owner));
    case 'owner-backup-validate-v1':
      return validateOwnerBackup(context, input?.section);
    case 'owner-backup-import-v1':
    case 'adoption-owner-import-v1':
      return importOwnerBackup(context, input);
    case 'workshop-bootstrap-v1':
      return workshopBootstrap(context, input);
    case 'taproot-blob-enumerate-v1':
      return enumerateBlobs(context, input);
    case 'taproot-blob-open-v1':
      return openBlob(context, input);
    case 'taproot-blob-stage-v1':
      return stageBlob(context, input);
    case 'taproot-blob-collision-check-v1':
      return inspectStagedBlobs(context, input, 'collision');
    case 'taproot-blob-rebind-v1':
      return inspectStagedBlobs(context, input, 'rebind');
    case 'taproot-blob-commit-v1':
      return inspectStagedBlobs(context, input, 'commit');
    case 'taproot-blob-rollback-v1':
      return inspectStagedBlobs(context, input, 'rollback');
    case 'adoption-payload-stage-v1':
      return stageAdoptionPayload(context, input);
    case 'adoption-payload-collision-check-v1':
      return inspectStagedBlobs(context, input, 'collision');
    case 'adoption-payload-rebind-v1':
      return inspectStagedBlobs(context, input, 'rebind');
    case 'adoption-payload-commit-v1':
      return inspectStagedBlobs(context, input, 'commit');
    case 'adoption-payload-rollback-v1':
      return inspectStagedBlobs(context, input, 'rollback');
    case 'adoption-diagnostics-v1':
      return adoptionDiagnostics(context, input);
    case 'legacy-owner-inspect-v1':
      return inspectLegacyOwners(context, request.source);
    case 'legacy-owner-export-v1':
      return exportLegacyOwners(context, request.source, input);
    case 'legacy-taproot-payload-open-v1':
      return openLegacyPayload(context, request.source, input);
    case 'restore-target-empty-v1':
      return {
        empty: !(await exists(context.databasePath)) && await directoryEmpty('/var/lib/gnolith/blobs'),
      };
    case 'restore-prepare-staging-v1':
      return prepareStaging(context, input);
    case 'restore-expose-database-last-v1':
      return exposeDatabaseLast(context, input);
    case 'restore-cleanup-v1':
      return cleanupStaging(context, input);
    default:
      throw new TypeError(`Unsupported operator operation ${name}`);
  }
}

async function inspectOwnerBackup(context, owner) {
  const exported = await exportOwnerBackup(context, owner);
  return {
    schemaVersion: exported.schemaVersion,
    disposition: exported.disposition,
    ledger: exported.ledger,
  };
}

async function exportOwnerBackup(context, owner) {
  const db = new NodeSqliteDatabase(context.databasePath);
  try {
    const binding = await backupBinding(db, context, owner);
    let value;
    if (owner === 'diamond') value = await binding.diamondBackup.export();
    if (owner === 'taproot') {
      value = await exportTaprootBackupSectionV1(
        db,
        context.installationId,
        binding.taprootLedgerHandle,
        { includeRebuildableDerived: false },
      );
    }
    if (owner === 'workshop') value = await binding.workshopBackup.exportBackup(context.installationId);
    const bytes = encodeOpaqueOwnerValue(value, { maxBytes: context.backup.maxArchiveBytes });
    const ledgerSlice = owner === 'workshop' ? value.sections.migrationLedgerSlice : value.ledger;
    return {
      owner,
      schemaVersion: TARGETS[owner],
      disposition: 'retained',
      ledger: {
        namespace: NAMESPACES[owner],
        schemaVersion: TARGETS[owner],
        digest: sha256(encodeOpaqueOwnerValue(ledgerSlice)),
      },
      base64: Buffer.from(bytes).toString('base64'),
    };
  } finally {
    await db.close();
  }
}

async function validateOwnerBackup(context, encoded) {
  const section = decodeTransportSection(encoded, context.backup.maxArchiveBytes);
  const liveDatabase = await exists(context.databasePath);
  const db = new NodeSqliteDatabase(liveDatabase ? context.databasePath : ':memory:');
  try {
    const binding = await backupBinding(db, context, section.owner);
    const value = decodeOpaqueOwnerValue(section.bytes, { maxBytes: context.backup.maxArchiveBytes });
    if (section.owner === 'diamond') {
      const inspection = await binding.diamondBackup.inspect();
      await binding.diamondBackup.dryRunImport(value, {
        mode: section.disposition === 'rebuildable'
          ? 'rebuild'
          : liveDatabase && inspection.schemaPresent
            ? 'migration-bound'
            : 'empty',
      });
    }
    if (section.owner === 'taproot') {
      if (!liveDatabase) {
        await binding.ledgerBackup.restoreNamespace(binding.ownerHandle, value.ledger, { mode: 'empty' });
      }
      await importTaprootBackupSectionV1(db, value, binding.taprootLedgerHandle, { dryRun: true, importDerived: false });
    }
    if (section.owner === 'workshop') {
      if (!liveDatabase) {
        await binding.workshopHandles.ledger.importOwnedSlice({
          state: value.sections.migrationLedgerSlice,
          signal: new AbortController().signal,
        });
      }
      await binding.workshopBackup.inspectBackup(value);
    }
    return retentionFor(section.owner);
  } catch (error) {
    throw new Error(`${section.owner} backup validation failed: ${error instanceof Error ? error.message : 'unknown owner error'}`);
  } finally {
    await db.close();
  }
}

async function importOwnerBackup(context, input) {
  const section = decodeTransportSection(input?.section, context.backup.maxArchiveBytes);
  const staging = assertStaging(context, input?.stagingDirectory);
  if (typeof input?.operationId !== 'string' || input.operationId !== staging.split('/').at(-1)) {
    throw new TypeError('Owner import operation does not match staging');
  }
  const db = new NodeSqliteDatabase(join(staging, 'gnolith.sqlite'));
  try {
    const binding = await backupBinding(db, context, section.owner);
    const value = decodeOpaqueOwnerValue(section.bytes, { maxBytes: context.backup.maxArchiveBytes });
    if (section.owner === 'diamond') {
      await binding.diamondBackup.import(value, { mode: 'empty' });
    }
    if (section.owner === 'taproot') {
      try {
        await binding.ledgerBackup.restoreNamespace(binding.ownerHandle, value.ledger, { mode: 'empty' });
      } catch (error) {
        throw new Error(`Taproot ledger/schema restore failed: ${error instanceof Error ? error.message : 'unknown owner error'}`);
      }
      try {
        await importTaprootBackupSectionV1(db, value, binding.taprootLedgerHandle, { importDerived: false });
      } catch (error) {
        throw new Error(`Taproot canonical restore failed: ${error instanceof Error ? error.message : 'unknown owner error'}`);
      }
    }
    if (section.owner === 'workshop') {
      await binding.workshopHandles.ledger.importOwnedSlice({
        state: value.sections.migrationLedgerSlice,
        signal: new AbortController().signal,
      });
      await binding.workshopHandles.owner.inspectOwnedState({
        state: value.sections.workshop,
        signal: new AbortController().signal,
      });
      await binding.workshopHandles.owner.importOwnedState({
        installationId: value.installationId,
        state: value.sections.workshop,
        expireTaskLeasesAt: new Date().toISOString(),
        signal: new AbortController().signal,
      });
    }
    return { imported: true };
  } finally {
    await db.close();
  }
}

async function backupBinding(db, context, owner) {
  const ledger = await ownerLedgerBinding(db, context, owner);
  if (owner === 'diamond') {
    return {
      ...ledger,
      diamondBackup: createDiamondBackupV1({
        db,
        owner: ledger.ownerHandle,
        ledgerBackup: ledger.ledgerBackup,
      }),
    };
  }
  const hostAuthority = await ephemeralTaprootAuthority(db, context.baseIri);
  if (owner === 'taproot') {
    return {
      ...ledger,
      taprootLedgerHandle: registerTaprootMigrationLedgerOwnerHandleV1(
        db,
        { baseIri: context.baseIri },
        hostAuthority,
        ledger.ownerHandle,
        ledger.ledgerBackup,
      ),
    };
  }
  const assembly = await readAssemblyConfig();
  const handles = createWorkshopOwnerHandlesV1({
    db,
    installationId: context.installationId,
    connectionId: ledger.ownerHandle.connectionId,
    registrationFingerprint: assembly.registrationFingerprint,
    ledgerBackup: ledger.ledgerBackup,
    ledgerOwner: ledger.ownerHandle,
  });
  return {
    ...ledger,
    workshopHandles: handles,
    workshopBackup: createWorkshopBackupApi({ ...handles, schemaVersion: 9 }),
  };
}

async function enumerateBlobs(context, input) {
  const limit = input?.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new TypeError('Blob enumeration limit is invalid');
  const db = new NodeSqliteDatabase(context.databasePath);
  try {
    const blobs = [];
    let cursor = null;
    while (blobs.length < limit) {
      const page = await enumerateResourceBlobDescriptorsV1(db, context.installationId, {
        cursor,
        limit: Math.min(100, limit - blobs.length),
      });
      for (const descriptor of page.items) {
        blobs.push({
          id: descriptor.referenceId,
          bytes: descriptor.byteLength,
          sha256: descriptor.sha256,
          ownerDescriptorBase64: Buffer.from(encodeOpaqueOwnerValue(descriptor)).toString('base64'),
        });
      }
      cursor = page.cursor;
      if (cursor === null) break;
    }
    if (cursor !== null) throw new TypeError('Blob enumeration exceeded the configured installation bound');
    return { blobs };
  } finally {
    await db.close();
  }
}

async function openBlob(context, input) {
  assertStreamMode('--stream-out');
  const descriptor = decodeBlobDescriptor(input);
  const db = new NodeSqliteDatabase(context.databasePath);
  try {
    const ports = await createLocalFilesystemResourceBlobPortsV1({
      root: '/var/lib/gnolith/blobs',
      maxBlobBytes: context.backup.maxBlobBytes,
      maxEntries: 10_000,
    });
    const stream = await openVerifiedResourceBlobV1(
      db,
      context.installationId,
      ports.backup,
      descriptor,
    );
    for await (const chunk of stream) {
      if (!process.stdout.write(chunk)) await new Promise((resolveDrain) => process.stdout.once('drain', resolveDrain));
    }
    return STREAMED;
  } finally {
    await db.close();
  }
}

async function stageBlob(context, input) {
  assertStreamMode('--stream-in');
  const descriptor = decodeBlobDescriptor(input);
  if (input.bytes !== descriptor.byteLength || input.sha256 !== descriptor.sha256) throw new TypeError('Blob staging metadata does not match owner descriptor');
  const staging = assertStaging(context, input.stagingDirectory);
  const ports = await createLocalFilesystemResourceBlobPortsV1({
    root: '/var/lib/gnolith/blobs',
    maxBlobBytes: context.backup.maxBlobBytes,
    maxEntries: 10_000,
  });
  const stageId = await ports.restore.stage(descriptor, readableFromStdin());
  await ports.restore.verify(stageId);
  const entries = await readStageEntries(staging);
  if (entries.some((entry) => entry.descriptor.referenceId === descriptor.referenceId)) throw new TypeError('Blob is duplicated in restore staging');
  entries.push({ descriptor, stageId });
  await writeStageEntries(staging, entries);
  return STREAMED;
}

async function stageAdoptionPayload(context, input) {
  assertStreamMode('--stream-in');
  const staging = assertStaging(context, input?.stagingDirectory);
  if (input?.operationId !== staging.split('/').at(-1) || typeof input?.id !== 'string') {
    throw new TypeError('Legacy payload staging input is invalid');
  }
  const adoption = await readAdoptionEvidence(staging);
  const descriptor = adoption.descriptors.find((entry) => entry.referenceId === input.id);
  if (!descriptor) throw new TypeError('Legacy payload descriptor is absent from the owner export');
  const ports = await createLocalFilesystemResourceBlobPortsV1({
    root: '/var/lib/gnolith/blobs',
    maxBlobBytes: context.backup.maxBlobBytes,
    maxEntries: 10_000,
  });
  const stageId = await ports.restore.stage(descriptor, readableFromStdin());
  await ports.restore.verify(stageId);
  const entries = await readStageEntries(staging);
  if (entries.some((entry) => entry.descriptor.referenceId === descriptor.referenceId)) {
    throw new TypeError('Legacy payload is duplicated in adoption staging');
  }
  entries.push({ descriptor, stageId });
  await writeStageEntries(staging, entries);
  return STREAMED;
}

async function adoptionDiagnostics(context, input) {
  const staging = assertStaging(context, input?.stagingDirectory);
  const evidence = await readAdoptionEvidence(staging);
  const db = new NodeSqliteDatabase(join(staging, 'gnolith.sqlite'));
  try {
    for (const owner of ['diamond', 'taproot', 'workshop']) {
      const diagnostic = await ownerDiagnosticWithDb(db, context, owner);
      if (!diagnostic.ready) throw new TypeError(`${owner} adoption target is not migration-ready`);
    }
  } finally {
    await db.close();
  }
  return {
    installationId: evidence.installationId,
    baseIri: evidence.baseIri,
    catalogDigest: context.migrations.expectedCatalogDigest,
    counts: evidence.counts,
    payloadDigests: evidence.descriptors.map((descriptor) => ({
      id: descriptor.referenceId,
      bytes: descriptor.byteLength,
      sha256: descriptor.sha256,
    })),
  };
}

async function inspectStagedBlobs(context, input, action) {
  const staging = assertStaging(context, input?.stagingDirectory);
  const ports = await createLocalFilesystemResourceBlobPortsV1({
    root: '/var/lib/gnolith/blobs',
    maxBlobBytes: context.backup.maxBlobBytes,
    maxEntries: 10_000,
  });
  const entries = await readStageEntries(staging);
  if (action === 'collision') {
    for (const entry of entries) {
      const result = await ports.restore.checkCollision(entry.descriptor);
      if (result === 'conflict') throw new TypeError(`Blob ${entry.descriptor.referenceId} conflicts with restore target`);
    }
  }
  if (action === 'rebind') {
    for (const entry of entries) await ports.restore.rebind(entry.stageId, entry.descriptor.referenceId);
  }
  if (action === 'commit') await ports.restore.commit(entries.map((entry) => entry.stageId));
  if (action === 'rollback') await ports.restore.rollback(entries.map((entry) => entry.stageId));
  return { [action]: entries.length };
}

async function migrationPlan(context, input) {
  const owner = assertOwner(input?.owner);
  if (input?.expectedVersion !== context.migrations[owner] || input.expectedVersion !== TARGETS[owner]) {
    throw new TypeError(`${owner} expected migration target does not match the component lock`);
  }
  const db = new NodeSqliteDatabase(await exists(context.databasePath) ? context.databasePath : ':memory:');
  try {
    const plan = await inspectOwnerPlan(db, owner, context);
    return {
      current: plan.current,
      target: TARGETS[owner],
      digest: digest(plan.entries),
    };
  } finally {
    await db.close();
  }
}

async function applyMigration(context, input) {
  const owner = assertOwner(input?.owner);
  if (
    input?.expectedVersion !== context.migrations[owner]
    || input.expectedVersion !== TARGETS[owner]
    || typeof input.operationId !== 'string'
    || !/^[0-9a-f]{64}$/u.test(input.operationId)
  ) throw new TypeError('Migration apply is not bound to the exact plan target and operation');
  await mkdir(dirname(context.databasePath), { recursive: true });
  const db = new NodeSqliteDatabase(context.databasePath);
  try {
    if (owner === 'diamond') await migrateDiamondStore(db);
    if (owner === 'taproot') await applyTaprootMigrations(db, { baseIri: context.baseIri });
    if (owner === 'workshop') await applyWorkshopMigrations(db, DIAMOND_LEDGER_API);
    return await ownerDiagnosticWithDb(db, context, owner);
  } finally {
    await db.close();
  }
}

async function ownerDiagnostic(context, owner) {
  const db = new NodeSqliteDatabase(await exists(context.databasePath) ? context.databasePath : ':memory:');
  try {
    return await ownerDiagnosticWithDb(db, context, owner);
  } finally {
    await db.close();
  }
}

async function ownerDiagnosticWithDb(db, context, owner) {
  const plan = await inspectOwnerPlan(db, owner, context);
  const ready = plan.ready && plan.target === TARGETS[owner];
  let ledgerDigest = digest(plan.entries);
  if (ready) {
    const binding = await ownerLedgerBinding(db, context, owner);
    const slice = await binding.ledgerBackup.exportNamespace(binding.ownerHandle);
    ledgerDigest = sha256(encodeOpaqueOwnerValue(slice));
  }
  return {
    owner,
    packageVersion: VERSIONS[owner],
    schemaVersion: TARGETS[owner],
    migrationDigest: digest(plan.entries),
    ready,
    ledger: {
      namespace: NAMESPACES[owner],
      schemaVersion: TARGETS[owner],
      digest: ledgerDigest,
    },
  };
}

async function inspectOwnerPlan(db, owner, context) {
  if (owner === 'diamond') {
    const applied = await readAppliedMigrations(db, diamondMigrationNamespace).catch(() => []);
    const entries = await Promise.all(diamondMigrations.map(async (migration) => ({
      id: migration.id,
      checksum: await checksumMigration(migration),
      applied: applied.some((entry) => entry.id === migration.id),
    })));
    return {
      current: applied.at(-1)?.id ?? null,
      target: diamondMigrations.at(-1)?.id ?? '',
      ready: entries.length > 0 && entries.every((entry) => entry.applied),
      entries,
    };
  }
  if (owner === 'taproot') {
    const inspection = await inspectTaprootPersistence(db).catch(() => null);
    const entries = await planTaprootMigrations(db).catch(() => []);
    const current = [...entries].reverse().find((entry) => entry.status === 'applied' || entry.status === 'adoptable')?.id ?? null;
    return {
      current,
      target: taprootMigrations.at(-1)?.id ?? '',
      ready: inspection?.current === true && entries.length > 0 && entries.every((entry) => entry.status === 'applied' || entry.status === 'adoptable'),
      entries,
    };
  }
  const plan = await planWorkshopMigrations(db, DIAMOND_LEDGER_API).catch(() => ({
    currentVersion: 0,
    targetVersion: 9,
    ready: false,
    pending: [],
  }));
  return {
    current: plan.currentVersion === 0 ? null : String(plan.currentVersion),
    target: String(plan.targetVersion),
    ready: plan.ready,
    entries: plan.pending.length === 0
      ? [{ id: String(plan.targetVersion), checksum: 'applied', applied: plan.ready }]
      : plan.pending.map((entry) => ({ id: entry.id, checksum: entry.checksum, applied: false })),
  };
}

async function ownerLedgerBinding(db, context, owner) {
  const assemblyAuthority = createMigrationAssemblyAuthorityV1(db, context.installationId);
  const migrations = owner === 'diamond' ? diamondMigrations : owner === 'taproot' ? taprootMigrations : workshopNamespacedMigrationsV1;
  const ownerHandle = await registerMigrationLedgerOwnerV1({
    db,
    installationId: context.installationId,
    namespace: NAMESPACES[owner],
    migrations,
    assemblyAuthority,
  });
  return {
    assemblyAuthority,
    ownerHandle,
    ledgerBackup: createMigrationLedgerBackupV1(db, assemblyAuthority),
  };
}

async function workshopBootstrap(context, input) {
  if (
    input?.installationId !== context.installationId
    || input.baseIri !== context.baseIri
    || input.credentialId !== context.credentialId
    || input.tokenFile !== context.tokenFile
    || typeof input.operationId !== 'string'
    || !/^[0-9a-f]{64}$/u.test(input.operationId)
  ) throw new TypeError('Workshop bootstrap input does not match the exact installation plan');
  const result = await exec('gnolith-workshop', [
    'bootstrap-v1',
    '--config', '/app/seedbed/workshop.config.json',
    '--installation-id', context.installationId,
    '--base-iri', context.baseIri,
    '--principal', context.credentialId,
    '--workspace', 'default',
    '--credential-file', context.tokenFile,
    '--idempotency-key', input.operationId,
  ], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    env: { PATH: process.env.PATH, NODE_ENV: 'production' },
  });
  const receipt = JSON.parse(result.stdout);
  if (
    receipt.installationId !== context.installationId
    || receipt.principalId !== context.credentialId
    || typeof receipt.credentialId !== 'string'
    || typeof receipt.credentialDigest !== 'string'
    || !/^[0-9a-f]{64}$/u.test(receipt.credentialDigest)
  ) {
    throw new TypeError('Workshop bootstrap receipt identity mismatch');
  }
  return {
    installationId: context.installationId,
    baseIri: context.baseIri,
    catalogDigest: context.migrations.expectedCatalogDigest,
    credentialId: receipt.credentialId,
    credentialDigest: receipt.credentialDigest,
  };
}

async function prepareStaging(context, input) {
  const staging = assertStaging(context, input?.stagingDirectory);
  if (input?.operationId !== staging.split('/').at(-1)) throw new TypeError('Restore staging operation ID mismatch');
  await mkdir(join(staging, 'blobs'), { recursive: true });
  const db = new NodeSqliteDatabase(join(staging, 'gnolith.sqlite'));
  await db.close();
  return { prepared: true };
}

async function exposeDatabaseLast(context, input) {
  const staging = assertStaging(context, input?.stagingDirectory);
  if (input?.operationId !== staging.split('/').at(-1)) throw new TypeError('Restore staging operation ID mismatch');
  if (await exists(context.databasePath)) throw new TypeError('Restore target database is not empty');
  await mkdir(dirname(context.databasePath), { recursive: true });
  await rename(join(staging, 'gnolith.sqlite'), context.databasePath);
  await rm(staging, { recursive: true, force: true });
  return { exposed: true };
}

async function cleanupStaging(context, input) {
  const staging = assertStaging(context, input?.stagingDirectory);
  await rm(staging, { recursive: true, force: true });
  return { cleaned: true };
}

function decodeTransportSection(value, maxBytes) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Owner section transport is invalid');
  const owner = assertOwner(value.owner);
  if (
    value.schemaVersion !== TARGETS[owner]
    || !['retained', 'rebuildable', 'deferred'].includes(value.disposition)
    || value.ledger?.namespace !== NAMESPACES[owner]
    || value.ledger?.schemaVersion !== TARGETS[owner]
    || typeof value.ledger?.digest !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.ledger.digest)
    || typeof value.base64 !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.base64)
  ) throw new TypeError('Owner section metadata is invalid');
  const bytes = Buffer.from(value.base64, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes || bytes.toString('base64') !== value.base64) {
    throw new TypeError('Owner section bytes are invalid');
  }
  return { owner, bytes, disposition: value.disposition };
}

function retentionFor(owner) {
  if (owner === 'diamond') return { retained: ['RDF quads and patch guards'] };
  if (owner === 'taproot') {
    return {
      retained: ['Items, Properties, Statements, Resources, Annotations, revisions, authorization, audit, and semantic configuration metadata'],
      rebuildable: ['lexical projections', 'chunks', 'embeddings', 'vector indexes'],
    };
  }
  return {
    retained: ['Tasks, Memories, Prompts, revisions, attribution, authorization, audit, and onboarding state'],
    expired: ['live task leases'],
  };
}

async function ephemeralTaprootAuthority(db, baseIri) {
  const key = await webcrypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
  return createTaprootHostWriteCapability(db, { baseIri }, key);
}

async function readAssemblyConfig() {
  const bytes = await readFile('/app/seedbed/assembly.config.json');
  if (bytes.byteLength > 1024 * 1024) throw new TypeError('Seedbed assembly config exceeds bound');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (
    !value
    || value.format !== 'gnolith-seedbed-local-assembly-v1'
    || typeof value.registrationFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.registrationFingerprint)
  ) throw new TypeError('Seedbed assembly config is invalid');
  return value;
}

async function inspectLegacyOwners(context, source) {
  const decoded = await decodeLegacyOwners(context, source);
  try {
    return legacyEvidence(decoded);
  } finally {
    await decoded.sourceDb.close();
  }
}

async function exportLegacyOwners(context, source, input) {
  const staging = assertStaging(context, input?.target?.stagingDirectory);
  if (input?.target?.operationId !== staging.split('/').at(-1)) {
    throw new TypeError('Legacy export target is not bound to the adoption operation');
  }
  const decoded = await decodeLegacyOwners(context, source);
  const target = new NodeSqliteDatabase(':memory:');
  try {
    await migrateDiamondStore(target);
    await applyTaprootMigrations(target, { baseIri: decoded.taproot.baseIri });
    await applyWorkshopMigrations(target, DIAMOND_LEDGER_API);

    const diamondSection = adoptDiamond041LegacyOwnerV1(decoded.diamond);
    const taprootLedger = await ownerLedgerBinding(target, context, 'taproot');
    const hostAuthority = await ephemeralTaprootAuthority(target, decoded.taproot.baseIri);
    const taprootHandle = registerTaprootMigrationLedgerOwnerHandleV1(
      target,
      { baseIri: decoded.taproot.baseIri },
      hostAuthority,
      taprootLedger.ownerHandle,
      taprootLedger.ledgerBackup,
    );
    const taprootSection = await convertLegacyTaproot042ToBackupSectionV1(target, decoded.taproot, taprootHandle);

    const workshopLedger = await ownerLedgerBinding(target, context, 'workshop');
    const assembly = await readAssemblyConfig();
    const workshopAdoption = createWorkshopLegacyOwnerAdoptionHandleV1(target, {
      connectionId: workshopLedger.ownerHandle.connectionId,
      registrationFingerprint: assembly.registrationFingerprint,
    });
    await adoptWorkshopLegacyOwnerV042(decoded.workshop, workshopAdoption, decoded.taproot.installationId);
    const workshopHandles = createWorkshopOwnerHandlesV1({
      db: target,
      installationId: decoded.taproot.installationId,
      connectionId: workshopLedger.ownerHandle.connectionId,
      registrationFingerprint: assembly.registrationFingerprint,
      ledgerBackup: workshopLedger.ledgerBackup,
      ledgerOwner: workshopLedger.ownerHandle,
    });
    const workshopSection = await createWorkshopBackupApi({
      ...workshopHandles,
      schemaVersion: 9,
    }).exportBackup(decoded.taproot.installationId);

    const evidence = legacyEvidence(decoded);
    await writeFile(join(staging, 'legacy-adoption-evidence.opaque'), encodeOpaqueOwnerValue({
      installationId: evidence.installationId,
      baseIri: evidence.baseIri,
      counts: evidence.counts,
      descriptors: decoded.taproot.blobDescriptors,
    }), { mode: 0o600 });
    return {
      ...evidence,
      sections: [
        encodeLegacySection('diamond', diamondSection, diamondSection.ledger, 'retained', context),
        encodeLegacySection('taproot', taprootSection, taprootSection.ledger, 'retained', context),
        encodeLegacySection('workshop', workshopSection, workshopSection.sections.migrationLedgerSlice, 'retained', context),
      ],
    };
  } finally {
    await target.close();
    await decoded.sourceDb.close();
  }
}

async function openLegacyPayload(context, source, input) {
  assertStreamMode('--stream-out');
  const decoded = await decodeLegacyOwners(context, source, { taprootOnly: true });
  try {
    const descriptor = decoded.taproot.blobDescriptors.find((entry) => entry.referenceId === input?.payloadId);
    if (!descriptor) throw new TypeError('Legacy payload identifier is not owned by the exact source');
    const ports = await createLocalFilesystemResourceBlobPortsV1({
      root: '/seedbed-legacy/blobs',
      maxBlobBytes: context.backup.maxBlobBytes,
      maxEntries: 10_000,
    });
    const stream = await openVerifiedResourceBlobV1(
      decoded.sourceDb,
      decoded.taproot.installationId,
      ports.backup,
      descriptor,
    );
    for await (const chunk of stream) {
      if (!process.stdout.write(chunk)) await new Promise((resolveDrain) => process.stdout.once('drain', resolveDrain));
    }
    return STREAMED;
  } finally {
    await decoded.sourceDb.close();
  }
}

async function decodeLegacyOwners(context, source, options = {}) {
  assertLegacySource(source);
  const sourceDb = new ReadOnlyPortableSql(source.databasePath);
  try {
    const taproot = await inspectLegacyTaproot042ForAdoptionV1(sourceDb, {
      packageName: '@gnolith/taproot',
      packageVersion: '0.4.2',
    });
    if (options.taprootOnly) return { sourceDb, taproot };
    const diamond = await decodeDiamond041LegacyOwnerV1({
      source: sourceDb,
      attestation: { packageName: '@gnolith/diamond', packageVersion: '0.4.1' },
      limits: { maxQuads: 1_000_000, maxPayloadBytes: context.backup.maxArchiveBytes },
    });
    const migrations = [];
    for (const migration of workshopNamespacedMigrationsV1.slice(0, 6)) {
      migrations.push({ id: migration.id, checksum: `sha256:${await checksumMigration(migration)}` });
    }
    const workshop = await decodeWorkshopLegacyOwnerV042(sourceDb, {
      packageName: '@gnolith/workshop',
      packageVersion: '0.4.2',
      schemaVersion: 6,
      migrationLedger: { namespace: '@gnolith/workshop', migrations },
    }, {
      maxRows: 1_000_000,
      maxBytes: context.backup.maxArchiveBytes,
    });
    return { sourceDb, diamond, taproot, workshop };
  } catch (error) {
    await sourceDb.close();
    throw error;
  }
}

function legacyEvidence(decoded) {
  const descriptors = decoded.taproot.blobDescriptors;
  return {
    installationId: decoded.taproot.installationId,
    baseIri: decoded.taproot.baseIri,
    packages: { diamond: '0.4.1', taproot: '0.4.2', workshop: '0.4.2', seedbed: '0.3.2' },
    counts: {
      items: decoded.taproot.domainCounts.items,
      properties: decoded.taproot.domainCounts.properties,
      statements: decoded.taproot.domainCounts.statements,
      resources: decoded.taproot.domainCounts.resources,
      annotations: decoded.taproot.domainCounts.annotations,
      tasks: decoded.workshop?.counts.tasks ?? 0,
      memories: decoded.workshop?.counts.memories ?? 0,
      prompts: decoded.workshop?.counts.prompts ?? 0,
      revisions: decoded.taproot.domainCounts.revisions + (decoded.workshop?.counts.revisions ?? 0),
      payloads: descriptors.length,
    },
    payloadDigests: descriptors.map((descriptor) => ({
      id: descriptor.referenceId,
      bytes: descriptor.byteLength,
      sha256: descriptor.sha256,
    })),
    locked: false,
  };
}

function encodeLegacySection(owner, value, ledgerSlice, disposition, context) {
  const bytes = encodeOpaqueOwnerValue(value, { maxBytes: context.backup.maxArchiveBytes });
  return {
    owner,
    schemaVersion: TARGETS[owner],
    disposition,
    ledger: {
      namespace: NAMESPACES[owner],
      schemaVersion: TARGETS[owner],
      digest: sha256(encodeOpaqueOwnerValue(ledgerSlice)),
    },
    base64: Buffer.from(bytes).toString('base64'),
  };
}

async function readAdoptionEvidence(staging) {
  const value = decodeOpaqueOwnerValue(
    await readFile(join(staging, 'legacy-adoption-evidence.opaque')),
    { maxBytes: 8 * 1024 * 1024 },
  );
  if (
    !value
    || typeof value.installationId !== 'string'
    || typeof value.baseIri !== 'string'
    || !value.counts
    || !Array.isArray(value.descriptors)
    || value.descriptors.length > 10_000
  ) throw new TypeError('Legacy adoption evidence is invalid');
  return value;
}

function assertLegacySource(value) {
  if (
    !value
    || value.kind !== 'read-only-portable-source-v1'
    || value.databasePath !== '/seedbed-legacy/source.sqlite'
    || value.blobPath !== '/seedbed-legacy/blobs'
    || value.offlineAttestation !== 'seedbed-filesystem-sidecars-absent-v1'
  ) throw new TypeError('Legacy source capability is invalid');
}

function decodeBlobDescriptor(input) {
  if (
    !input
    || typeof input.ownerDescriptorBase64 !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(input.ownerDescriptorBase64)
  ) throw new TypeError('Blob owner descriptor transport is invalid');
  const bytes = Buffer.from(input.ownerDescriptorBase64, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > 1024 * 1024 || bytes.toString('base64') !== input.ownerDescriptorBase64) {
    throw new TypeError('Blob owner descriptor bytes are invalid');
  }
  const descriptor = decodeOpaqueOwnerValue(bytes);
  if (
    !descriptor
    || typeof descriptor !== 'object'
    || typeof descriptor.referenceId !== 'string'
    || descriptor.referenceId !== input.id
    || typeof descriptor.resourceId !== 'string'
    || !Number.isSafeInteger(descriptor.revision)
    || !Number.isSafeInteger(descriptor.byteLength)
    || typeof descriptor.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(descriptor.sha256)
    || typeof descriptor.mediaType !== 'string'
  ) throw new TypeError('Blob owner descriptor is invalid');
  return descriptor;
}

function readableFromStdin() {
  const iterator = process.stdin[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const result = await iterator.next();
      if (result.done) controller.close();
      else controller.enqueue(new Uint8Array(result.value));
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

async function readStageEntries(staging) {
  try {
    const bytes = await readFile(join(staging, 'blob-stages.opaque'));
    const entries = decodeOpaqueOwnerValue(bytes, { maxBytes: 8 * 1024 * 1024 });
    if (!Array.isArray(entries) || entries.length > 10_000) throw new TypeError('Blob stage inventory is invalid');
    return entries;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeStageEntries(staging, entries) {
  const bytes = encodeOpaqueOwnerValue(entries, { maxBytes: 8 * 1024 * 1024 });
  await writeFile(join(staging, 'blob-stages.opaque'), bytes, { mode: 0o600 });
}

function assertStreamMode(mode) {
  if (!process.argv.includes(mode)) throw new TypeError(`Operator operation requires ${mode}`);
}

function assertStaging(context, value) {
  if (typeof value !== 'string' || !/^\/var\/lib\/gnolith\/\.seedbed-staging\/[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError('Restore staging path is invalid');
  }
  const canonical = resolve(value);
  const root = resolve(dirname(context.databasePath), '.seedbed-staging');
  if (!canonical.startsWith(`${root}/`)) throw new TypeError('Restore staging path escapes application data');
  return canonical;
}

async function readRequest() {
  const streamIn = process.argv.indexOf('--stream-in');
  if (streamIn >= 0) {
    const encoded = process.argv[streamIn + 1];
    if (!encoded || encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new TypeError('Streaming metadata is invalid');
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.byteLength;
    if (bytes > 16 * 1024 * 1024) throw new TypeError('Seedbed operator request exceeds bound');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function assertContext(value) {
  if (
    !value
    || value.format !== 'gnolith-seedbed-operator-context-v1'
    || typeof value.installationId !== 'string'
    || typeof value.baseIri !== 'string'
    || value.databasePath !== '/var/lib/gnolith/gnolith.sqlite'
    || value.tokenFile !== '/run/secrets/gnolith-bearer'
    || typeof value.credentialId !== 'string'
    || !value.migrations
  ) throw new TypeError('Seedbed operator context is invalid');
}

function assertOwner(value) {
  if (!['diamond', 'taproot', 'workshop'].includes(value)) throw new TypeError('Owner is invalid');
  return value;
}

function digest(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function exists(path) {
  return stat(path).then(() => true).catch(() => false);
}

async function directoryEmpty(path) {
  try {
    return (await readdir(path)).length === 0;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

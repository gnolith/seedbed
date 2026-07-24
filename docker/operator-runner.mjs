import { createHash, webcrypto } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
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
  validateDiamondBackupSectionV1,
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
  restoreTaprootMigrationLedgerV1,
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
  workshopMigrations,
  workshopNamespacedMigrationsV1,
} from '@gnolith/workshop/migrations';
import { decodeOpaqueOwnerValue, encodeOpaqueOwnerValue } from './opaque-codec.mjs';
import { ReadOnlyPortableSql } from './read-only-sql.mjs';

const exec = promisify(execFile);
const TARGETS = {
  diamond: '0001-current-rdf-schema',
  taproot: '0009-architecture-reset',
  workshop: '11',
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
  process.stderr.write(`${JSON.stringify({
    message: message.slice(0, 2048).replaceAll(/(?:[A-Za-z]:[\\/][^\s"']+|(?<![A-Za-z0-9@._-])\/[^\s"']+)/gu, '[redacted-path]'),
    ...(error?.operatorDiagnostic === undefined ? {} : { diagnostic: error.operatorDiagnostic }),
  })}\n`);
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
    case 'workshop-semantic-configure-v1':
      return workshopSemanticConfigure(context, input);
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
  const value = decodeOpaqueOwnerValue(section.bytes, { maxBytes: context.backup.maxArchiveBytes });
  if (section.owner === 'diamond') {
    try {
      await validateDiamondBackupSectionV1(value);
      return retentionFor(section.owner);
    } catch (error) {
      throw new Error(`diamond backup validation failed: ${error instanceof Error ? error.message : 'unknown owner error'}`);
    }
  }
  // Verification is deliberately independent of the live installation. Owner
  // import/dry-run APIs require an empty target, so bind them to an isolated
  // in-memory database and close it after this single bounded validation.
  const db = new NodeSqliteDatabase(':memory:');
  try {
    const binding = await backupBinding(db, context, section.owner);
    if (section.owner === 'taproot') {
      await restoreTaprootMigrationLedgerV1(db, binding.taprootLedgerHandle, value.ledger);
      await importTaprootBackupSectionV1(db, value, binding.taprootLedgerHandle, { dryRun: true, importDerived: false });
    }
    if (section.owner === 'workshop') {
      try {
        await binding.workshopHandles.ledger.importOwnedSlice({
          state: value.sections.migrationLedgerSlice,
          signal: new AbortController().signal,
        });
        await binding.workshopBackup.inspectBackup(value);
      } catch (error) {
        const wrapped = new Error(`workshop backup validation failed: ${error instanceof Error ? error.message : 'unknown owner error'}`);
        wrapped.operatorDiagnostic = workshopBackupDiagnostic(value, context, error);
        throw wrapped;
      }
    }
    return retentionFor(section.owner);
  } catch (error) {
    const wrapped = new Error(`${section.owner} backup validation failed: ${error instanceof Error ? error.message : 'unknown owner error'}`);
    if (error?.operatorDiagnostic !== undefined) wrapped.operatorDiagnostic = error.operatorDiagnostic;
    throw wrapped;
  } finally {
    await db.close();
  }
}

function workshopBackupDiagnostic(value, context, error) {
  const tables = value?.sections?.workshop?.tables;
  const rows = tables && typeof tables === 'object' && !Array.isArray(tables)
    ? Object.values(tables).filter(Array.isArray).flat()
    : [];
  const credentials = Array.isArray(tables?.workshop_credentials)
    ? tables.workshop_credentials
    : [];
  const tokenDigests = credentials
    .map((row) => row?.token_digest)
    .filter((digest) => typeof digest === 'string' && /^[0-9a-f]{64}$/u.test(digest));
  const causeMessage = error instanceof Error ? error.message : '';
  return {
    format: 'gnolith-seedbed-owner-validation-diagnostic-v1',
    owner: 'workshop',
    documentFormat: value?.format === 'gnolith-workshop-backup-v1' ? value.format : 'unexpected',
    documentVersion: Number.isSafeInteger(value?.version) ? value.version : -1,
    schemaVersion: Number.isSafeInteger(value?.schemaVersion) ? value.schemaVersion : -1,
    installationMatches: value?.installationId === context.installationId,
    ownedStateFormat: value?.sections?.workshop?.format === 'gnolith-workshop-owned-state-v1'
      ? value.sections.workshop.format
      : 'unexpected',
    ownedStateInstallationMatches: value?.sections?.workshop?.installationId === context.installationId,
    tableCount: tables && typeof tables === 'object' && !Array.isArray(tables) ? Object.keys(tables).length : -1,
    rowCount: rows.length,
    credentialCount: credentials.length,
    distinctCredentialDigestCount: new Set(tokenDigests).size,
    documentSha256: sha256(encodeOpaqueOwnerValue(value)),
    causeName: error instanceof Error ? error.name.slice(0, 64) : 'unknown',
    causeCode: typeof error?.code === 'string' ? error.code.slice(0, 64) : 'unknown',
    causeBackupReason: typeof error?.details?.backupReason === 'string'
      ? error.details.backupReason.slice(0, 64)
      : 'unknown',
    causeTable: typeof error?.details?.table === 'string' ? error.details.table.slice(0, 64) : 'unknown',
    causeLogicalKeyCount: Number.isSafeInteger(error?.details?.logicalKeyCount)
      ? error.details.logicalKeyCount
      : -1,
    causeReason: /inconsistent duplicate/iu.test(causeMessage)
      ? 'inconsistent-duplicate-owner-record'
      : /unknown table/iu.test(causeMessage)
        ? 'unknown-owner-table'
        : /invalid rows or columns/iu.test(causeMessage)
          ? 'invalid-owner-row-shape'
          : /installation/iu.test(causeMessage)
            ? 'installation-identity-mismatch'
            : /migration|ledger|namespace/iu.test(causeMessage)
              ? 'migration-ledger-validation-failed'
              : 'owner-document-validation-failed',
  };
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
        await restoreTaprootMigrationLedgerV1(db, binding.taprootLedgerHandle, value.ledger);
      } catch (error) {
        throw new Error(`Taproot ledger/schema restore failed: ${error instanceof Error ? error.message : 'unknown owner error'}`);
      }
      try {
        await importTaprootBackupSectionV1(db, value, binding.taprootLedgerHandle, { importDerived: false });
        const inspection = await inspectTaprootPersistence(db);
        if (!inspection.current) {
          throw new TypeError(`Taproot canonical restore did not leave exact current persistence: ${JSON.stringify({
            readinessErrors: inspection.readinessErrors,
            baseIriMatchesContext: inspection.baseIri === context.baseIri,
            baseIriLength: inspection.baseIri?.length,
            expectedBaseIriLength: context.baseIri.length,
            baseIri: inspection.baseIri,
            schema: inspection.schema,
            migrations: inspection.migrations,
          })}`);
        }
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
    workshopBackup: createWorkshopBackupApi({ ...handles, schemaVersion: 11 }),
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
  const entries = await readStageEntries(staging);
  if (entries.some((entry) => entry.descriptor.referenceId === descriptor.referenceId)) throw new TypeError('Blob is duplicated in restore staging');
  entries.push(await stageIncomingPayload(staging, descriptor, context.backup.maxBlobBytes));
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
  const entries = await readStageEntries(staging);
  if (entries.some((entry) => entry.descriptor.referenceId === descriptor.referenceId)) {
    throw new TypeError('Legacy payload is duplicated in adoption staging');
  }
  entries.push(await stageIncomingPayload(staging, descriptor, context.backup.maxBlobBytes));
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
      if (!diagnostic.ready) {
        const plan = await inspectOwnerPlan(db, owner, context);
        throw new TypeError(`${owner} adoption target is not migration-ready: ${JSON.stringify({ diagnostic, plan })}`);
      }
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
  // Rebinding is intentionally completed in the same owner-port process as
  // commit. Workshop stage handles are process-local capabilities.
  if (action === 'rebind') {
    for (const entry of entries) await readStagedPayload(staging, entry, context.backup.maxBlobBytes);
  }
  if (action === 'commit') {
    const stageIds = [];
    try {
      for (const entry of entries) {
        const bytes = await readStagedPayload(staging, entry, context.backup.maxBlobBytes);
        const stageId = await ports.restore.stage(entry.descriptor, readableFromBytes(bytes));
        await ports.restore.verify(stageId);
        await ports.restore.rebind(stageId, entry.descriptor.referenceId);
        stageIds.push(stageId);
      }
      await ports.restore.commit(stageIds);
      await Promise.all(entries.map((entry) => rm(join(staging, 'payloads', entry.file), { force: true })));
    } catch (error) {
      await ports.restore.rollback(stageIds).catch(() => undefined);
      throw error;
    }
  }
  if (action === 'rollback') {
    await Promise.all(entries.map((entry) => rm(join(staging, 'payloads', entry.file), { force: true })));
  }
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
    targetVersion: 11,
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

async function workshopSemanticConfigure(context, input) {
  if (
    !input
    || input.version !== 1
    || !Number.isSafeInteger(input.expectedRevision)
    || input.expectedRevision < 0
    || typeof input.idempotencyKey !== 'string'
    || !/^seedbed-semantic-[0-9a-f]{64}$/u.test(input.idempotencyKey)
    || !input.configuration
    || typeof input.configuration !== 'object'
    || Array.isArray(input.configuration)
  ) throw new TypeError('Workshop semantic configuration input is invalid');
  const transient = `/tmp/${input.idempotencyKey}.json`;
  await writeFile(transient, `${JSON.stringify(input)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    const result = await exec('gnolith-workshop', [
      'configure-semantics-v1',
      '--config', '/app/seedbed/workshop.config.json',
      '--input', transient,
    ], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: { PATH: process.env.PATH, NODE_ENV: 'production' },
    });
    const receipt = JSON.parse(result.stdout);
    if (
      receipt?.version !== 1
      || receipt.configurationId !== input.configuration.id
      || !Number.isSafeInteger(receipt.revision)
      || typeof receipt.fingerprint !== 'string'
      || !/^[0-9a-f]{64}$/u.test(receipt.fingerprint)
      || typeof receipt.state !== 'string'
      || receipt.state.length < 1
      || receipt.state.length > 128
      || typeof receipt.ready !== 'boolean'
      || typeof receipt.replayed !== 'boolean'
    ) throw new TypeError('Workshop semantic configuration receipt is invalid');
    return {
      fingerprint: receipt.fingerprint,
      revision: receipt.revision,
      state: receipt.state,
    };
  } finally {
    await rm(transient, { force: true });
  }
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
      schemaVersion: 11,
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
    const root = await realpath('/seedbed-legacy/blobs');
    const relativePath = safeLegacyBlobReference(descriptor.referenceId);
    const payloadPath = join(root, ...relativePath.split('/'));
    const resolvedPayload = await realpath(payloadPath);
    if (resolvedPayload !== payloadPath || !resolvedPayload.startsWith(`${root}/`)) {
      throw new TypeError('Legacy payload path escapes the verified blob source');
    }
    const metadata = await lstat(resolvedPayload);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== descriptor.byteLength || metadata.size > context.backup.maxBlobBytes) {
      throw new TypeError('Legacy payload is not an exact bounded regular file');
    }
    const bytes = await readFile(resolvedPayload);
    if (sha256(bytes) !== descriptor.sha256) throw new TypeError('Legacy payload digest does not match its owner descriptor');
    if (!process.stdout.write(bytes)) await new Promise((resolveDrain) => process.stdout.once('drain', resolveDrain));
    return STREAMED;
  } finally {
    await decoded.sourceDb.close();
  }
}

function safeLegacyBlobReference(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 1024
    || value.includes('\\')
    || value.startsWith('/')
    || /^[A-Za-z]:/u.test(value)
    || value.split('/').some((part) => !part || part === '.' || part === '..')
  ) throw new TypeError('Legacy payload reference is unsafe');
  return value;
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
      limits: { maxQuads: 1_000_000, maxPayloadBytes: Math.min(context.backup.maxArchiveBytes, 64 * 1024 * 1024) },
    });
    const migrations = workshopMigrations.slice(0, 6).map(({ id, checksum }) => ({ id, checksum }));
    const workshop = await decodeWorkshopLegacyOwnerV042(sourceDb, {
      packageName: '@gnolith/workshop',
      packageVersion: '0.4.2',
      schemaVersion: 6,
      migrationLedger: { namespace: '@gnolith/workshop', migrations },
    }, {
      maxRows: 100_000,
      maxBytes: Math.min(context.backup.maxArchiveBytes, 32 * 1024 * 1024),
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

function readableFromBytes(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

async function stageIncomingPayload(staging, descriptor, maxBlobBytes) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of process.stdin) {
    byteLength += chunk.byteLength;
    if (byteLength > descriptor.byteLength || byteLength > maxBlobBytes) {
      throw new TypeError('Staged blob exceeds its exact owner descriptor');
    }
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength !== descriptor.byteLength || sha256(bytes) !== descriptor.sha256) {
    throw new TypeError('Staged blob does not match its exact owner descriptor');
  }
  const file = `${sha256(encodeOpaqueOwnerValue(descriptor))}.blob`;
  const directory = join(staging, 'payloads');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, file), bytes, { flag: 'wx', mode: 0o600 });
  return { descriptor, file };
}

async function readStagedPayload(staging, entry, maxBlobBytes) {
  if (
    !entry
    || !entry.descriptor
    || typeof entry.file !== 'string'
    || !/^[0-9a-f]{64}\.blob$/u.test(entry.file)
    || entry.file !== `${sha256(encodeOpaqueOwnerValue(entry.descriptor))}.blob`
  ) throw new TypeError('Blob stage inventory entry is invalid');
  const path = join(staging, 'payloads', entry.file);
  const metadata = await lstat(path);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.size !== entry.descriptor.byteLength
    || metadata.size > maxBlobBytes
  ) throw new TypeError('Blob stage payload is invalid');
  const bytes = await readFile(path);
  if (sha256(bytes) !== entry.descriptor.sha256) throw new TypeError('Blob stage payload digest is invalid');
  return bytes;
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

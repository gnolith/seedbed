import { createHash, randomUUID } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createNativeInstallationAdapter } from './adapter.js';
import { openAuthorization } from './authorization.js';
import type { SeedbedConfig } from './config.js';
import { requireBaseIri } from './config.js';
import { ExitCode, SeedbedError } from './errors.js';
import { inspectReadiness } from './persistence.js';
import type { TaprootAssembly } from './persistence.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const SNAPSHOT_FORMAT = 'gnolith-seedbed-snapshot-v1';
// Snapshot envelopes are intentionally bounded. The limits comfortably cover
// the supported 32 MiB+ portability case while preventing attacker-controlled
// gzip or base64 fields from driving unbounded allocations.
const MAX_COMPRESSED_BYTES = 192 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 192 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 128 * 1024 * 1024;

export interface SnapshotBlobEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly data: string;
}

export interface SnapshotManifest {
  readonly format: typeof SNAPSHOT_FORMAT;
  readonly createdAt: string;
  readonly installationId: string;
  readonly baseIri: string;
  readonly packages: Readonly<Record<'diamond' | 'taproot' | 'workshop' | 'seedbed', string>>;
  readonly database: { readonly bytes: number; readonly sha256: string };
  readonly blobs: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[];
  readonly secretsExported: false;
  readonly derivedStatePolicy: 'validate-compatible-or-discard-and-rebuild';
}

interface SnapshotEnvelope {
  readonly manifest: SnapshotManifest;
  readonly database: string;
  readonly blobs: readonly SnapshotBlobEntry[];
}

export interface SnapshotInspection {
  readonly valid: boolean;
  readonly path: string;
  readonly compressedBytes: number;
  readonly manifest: SnapshotManifest;
}

export interface RestoreTestHooks {
  /** Test-only deterministic interruption after blobs install but before the canonical database appears. */
  afterBlobsInstalled?(): void | Promise<void>;
}

export interface CreateSnapshotTestHooks {
  /** Test-only deterministic interruption after candidate write and verification, before publication. */
  afterArchiveVerified?(): void | Promise<void>;
}

export async function createInstallationSnapshot(
  config: SeedbedConfig,
  taproot: TaprootAssembly,
  outputPath: string,
  now = new Date(),
  hooks: CreateSnapshotTestHooks = {},
): Promise<SnapshotInspection> {
  requireMaintenancePrincipal(config);
  const adapter = createNativeInstallationAdapter(config);
  if (!(await adapter.exists())) throw snapshotError('Installation database does not exist', 'database_missing');
  const normalizedConfig = { ...config, baseIri: requireBaseIri(config) };
  const destination = resolve(outputPath);
  await mkdir(dirname(destination), { recursive: true });
  return adapter.withMaintenanceLock(async () => {
    if (await pathExists(destination)) throw snapshotError(`Snapshot already exists at ${destination}`, 'snapshot_exists');
    const temporaryDatabase = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.sqlite`);
    const temporaryArchive = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.snapshot`);
    const db = await adapter.open();
    try {
      const readiness = await inspectReadiness(db, normalizedConfig, taproot);
      if (!readiness.ready) throw snapshotError(`Installation is not ready for snapshot: ${JSON.stringify(readiness)}`, 'persistence_not_ready');
      const authority = await openAuthorization(db, normalizedConfig);
      const context = await authority.resolveContext(config.principalSelector!, config.workspaceSelector);
      if (!context.capabilities.includes('search:admin')) {
        throw snapshotError('Exact search:admin capability is required', 'forbidden', ExitCode.authorization);
      }
      // SQLite VACUUM INTO creates a transactionally consistent standalone
      // database even while WAL mode is active.
      await db.prepare('VACUUM INTO ?').bind(temporaryDatabase).run();
    } finally {
      await db.close();
    }
    try {
      const databaseBytes = await readBoundedFile(temporaryDatabase, MAX_PAYLOAD_BYTES, 'Snapshot database');
      const identity = await readSnapshotIdentity(temporaryDatabase);
      const blobs = await readBlobEntries(adapter.blobPath, databaseBytes.byteLength);
      requirePayloadBudget(databaseBytes.byteLength, blobs);
      const manifest: SnapshotManifest = Object.freeze({
        format: SNAPSHOT_FORMAT,
        createdAt: now.toISOString(),
        installationId: identity.installationId,
        baseIri: identity.baseIri,
        packages: Object.freeze(identity.packages),
        database: Object.freeze({ bytes: databaseBytes.byteLength, sha256: sha256(databaseBytes) }),
        blobs: Object.freeze(blobs.map(({ path, bytes, sha256: digest }) => Object.freeze({ path, bytes, sha256: digest }))),
        secretsExported: false,
        derivedStatePolicy: 'validate-compatible-or-discard-and-rebuild',
      });
      const envelope: SnapshotEnvelope = { manifest, database: databaseBytes.toString('base64'), blobs };
      const encoded = Buffer.from(JSON.stringify(envelope));
      if (encoded.byteLength > MAX_EXPANDED_BYTES) throw snapshotError('Snapshot envelope exceeds the supported size limit', 'snapshot_too_large');
      const compressed = await gzipAsync(encoded, { level: 9 });
      if (compressed.byteLength > MAX_COMPRESSED_BYTES) throw snapshotError('Compressed snapshot exceeds the supported size limit', 'snapshot_too_large');
      try {
        await writeFile(temporaryArchive, compressed, { flag: 'wx', mode: 0o600 });
        const verified = await inspectInstallationSnapshot(temporaryArchive, true);
        await hooks.afterArchiveVerified?.();
        if (await pathExists(destination)) throw snapshotError(`Snapshot already exists at ${destination}`, 'snapshot_exists');
        await rename(temporaryArchive, destination);
        return { ...verified, path: destination };
      } finally {
        await rm(temporaryArchive, { force: true });
      }
    } finally {
      await rm(temporaryDatabase, { force: true });
    }
  });
}

export async function inspectInstallationSnapshot(inputPath: string, verify = false): Promise<SnapshotInspection> {
  const path = resolve(inputPath);
  const compressed = await readBoundedFile(path, MAX_COMPRESSED_BYTES, 'Compressed snapshot');
  const envelope = await decodeEnvelope(compressed);
  if (verify) verifyEnvelope(envelope);
  return { valid: verify ? true : envelope.manifest.format === SNAPSHOT_FORMAT, path, compressedBytes: compressed.byteLength, manifest: envelope.manifest };
}

export async function restoreInstallationSnapshot(
  config: SeedbedConfig,
  taproot: TaprootAssembly,
  inputPath: string,
  hooks: RestoreTestHooks = {},
): Promise<SnapshotInspection> {
  requireMaintenancePrincipal(config);
  const adapter = createNativeInstallationAdapter(config);
  return adapter.withMaintenanceLock(async () => {
    if (await adapter.exists()) throw snapshotError('Restore target database already exists', 'restore_target_exists');
    if (await pathExists(adapter.blobPath)) throw snapshotError('Restore target blob directory already exists', 'restore_target_exists');
    const path = resolve(inputPath);
    const compressed = await readBoundedFile(path, MAX_COMPRESSED_BYTES, 'Compressed snapshot');
    const envelope = await decodeEnvelope(compressed);
    verifyEnvelope(envelope);
    const configuredBaseIri = requireBaseIri(config);
    if (configuredBaseIri !== envelope.manifest.baseIri) {
      throw snapshotError('Snapshot identity does not match the configured base IRI', 'identity_mismatch');
    }
    const databaseStage = `${adapter.databasePath}.restore-${randomUUID()}`;
    const blobStage = `${adapter.blobPath}.restore-${randomUUID()}`;
    await mkdir(dirname(databaseStage), { recursive: true });
    await mkdir(blobStage, { recursive: true });
    try {
      await writeFile(databaseStage, Buffer.from(envelope.database, 'base64'), { flag: 'wx', mode: 0o600 });
      for (const blob of envelope.blobs) {
        const target = safeBlobTarget(blobStage, blob.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(blob.data, 'base64'), { flag: 'wx', mode: 0o600 });
      }
      const stagedConfig: SeedbedConfig = { ...config, baseIri: configuredBaseIri, databasePath: databaseStage, blobPath: blobStage };
      const stagedDb = await createNativeInstallationAdapter(stagedConfig).open();
      try {
        const integrity = await stagedDb.prepare('PRAGMA integrity_check').all<{ integrity_check: string }>();
        if (integrity.results.length !== 1 || integrity.results[0]?.integrity_check !== 'ok') {
          throw snapshotError('Restored SQLite database failed integrity verification', 'snapshot_invalid');
        }
        const readiness = await inspectReadiness(stagedDb, stagedConfig, taproot);
        if (!readiness.ready) throw snapshotError(`Restored package schemas are not an exact compatible assembly: ${JSON.stringify(readiness)}`, 'snapshot_incompatible');
        const authority = await openAuthorization(stagedDb, stagedConfig);
        if (authority.installationId !== envelope.manifest.installationId) {
          throw snapshotError('Restored installation identity does not match its manifest', 'snapshot_invalid');
        }
        const context = await authority.resolveContext(config.principalSelector!, config.workspaceSelector);
        if (!context.capabilities.includes('search:admin')) {
          throw snapshotError('Exact search:admin capability is required', 'forbidden', ExitCode.authorization);
        }
      } finally {
        await stagedDb.close();
      }
      // Install blobs first and make the database visible last. An interrupted
      // restore therefore never exposes a canonical database that references a
      // partial blob tree.
      await rename(blobStage, adapter.blobPath);
      await hooks.afterBlobsInstalled?.();
      await rename(databaseStage, adapter.databasePath);
      return { valid: true, path, compressedBytes: compressed.byteLength, manifest: envelope.manifest };
    } catch (error) {
      await rm(databaseStage, { force: true });
      await rm(blobStage, { recursive: true, force: true });
      if (!(await pathExists(adapter.databasePath))) await rm(adapter.blobPath, { recursive: true, force: true });
      throw error;
    }
  });
}

async function decodeEnvelope(compressed: Buffer): Promise<SnapshotEnvelope> {
  let raw: unknown;
  try {
    raw = JSON.parse((await gunzipAsync(compressed, { maxOutputLength: MAX_EXPANDED_BYTES })).toString('utf8'));
  } catch (error) {
    throw snapshotError(`Snapshot cannot be decoded: ${error instanceof Error ? error.message : String(error)}`, 'snapshot_invalid');
  }
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw snapshotError('Snapshot envelope must be an object', 'snapshot_invalid');
  const candidate = raw as Record<string, unknown>;
  requireExactKeys(candidate, ['blobs', 'database', 'manifest'], 'snapshot envelope');
  if (typeof candidate.database !== 'string' || !Array.isArray(candidate.blobs)) {
    throw snapshotError('Snapshot envelope has an unsupported format', 'snapshot_invalid');
  }
  const manifest = parseManifest(candidate.manifest);
  requirePayloadBudget(manifest.database.bytes, manifest.blobs);
  const blobs = candidate.blobs.map((value, index) => parseBlobEntry(value, `snapshot blob ${index}`));
  return { manifest, database: candidate.database, blobs };
}

function verifyEnvelope(envelope: SnapshotEnvelope): void {
  if (envelope.manifest.secretsExported !== false) throw snapshotError('Snapshot does not attest secret exclusion', 'snapshot_invalid');
  const database = decodeBase64(envelope.database, 'snapshot database');
  if (database.byteLength !== envelope.manifest.database.bytes || sha256(database) !== envelope.manifest.database.sha256) {
    throw snapshotError('Snapshot database checksum does not match', 'snapshot_invalid');
  }
  const expected = new Map(envelope.manifest.blobs.map((blob) => [blob.path, blob]));
  if (expected.size !== envelope.manifest.blobs.length || envelope.blobs.length !== expected.size) {
    throw snapshotError('Snapshot blob manifest is inconsistent', 'snapshot_invalid');
  }
  for (const blob of envelope.blobs) {
    validateBlobPath(blob.path);
    const bytes = decodeBase64(blob.data, `snapshot blob ${blob.path}`);
    const declaration = expected.get(blob.path);
    if (!declaration || bytes.byteLength !== blob.bytes || bytes.byteLength !== declaration.bytes
      || sha256(bytes) !== blob.sha256 || blob.sha256 !== declaration.sha256) {
      throw snapshotError(`Snapshot blob checksum does not match for ${blob.path}`, 'snapshot_invalid');
    }
  }
}

function parseManifest(value: unknown): SnapshotManifest {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw snapshotError('Snapshot manifest must be an object', 'snapshot_invalid');
  const manifest = value as Record<string, unknown>;
  requireExactKeys(manifest, [
    'baseIri', 'blobs', 'createdAt', 'database', 'derivedStatePolicy', 'format', 'installationId', 'packages', 'secretsExported',
  ], 'snapshot manifest');
  if (manifest.format !== SNAPSHOT_FORMAT || manifest.secretsExported !== false
    || manifest.derivedStatePolicy !== 'validate-compatible-or-discard-and-rebuild'
    || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))
    || typeof manifest.installationId !== 'string' || manifest.installationId.length === 0
    || typeof manifest.baseIri !== 'string' || manifest.baseIri.length === 0
    || !manifest.packages || Array.isArray(manifest.packages) || typeof manifest.packages !== 'object'
    || !manifest.database || Array.isArray(manifest.database) || typeof manifest.database !== 'object'
    || !Array.isArray(manifest.blobs)) {
    throw snapshotError('Snapshot manifest has invalid fields', 'snapshot_invalid');
  }
  const packages = manifest.packages as Record<string, unknown>;
  requireExactKeys(packages, ['diamond', 'seedbed', 'taproot', 'workshop'], 'snapshot package tuple');
  if (Object.values(packages).some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw snapshotError('Snapshot package tuple is invalid', 'snapshot_invalid');
  }
  const database = parseDigestDeclaration(manifest.database, 'snapshot database declaration');
  const blobs = manifest.blobs.map((entry, index) => parseDigestDeclaration(entry, `snapshot blob declaration ${index}`, true));
  return {
    format: SNAPSHOT_FORMAT,
    createdAt: manifest.createdAt,
    installationId: manifest.installationId,
    baseIri: manifest.baseIri,
    packages: packages as SnapshotManifest['packages'],
    database,
    blobs: blobs as SnapshotManifest['blobs'],
    secretsExported: false,
    derivedStatePolicy: 'validate-compatible-or-discard-and-rebuild',
  };
}

function parseBlobEntry(value: unknown, label: string): SnapshotBlobEntry {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw snapshotError(`${label} must be an object`, 'snapshot_invalid');
  const entry = value as Record<string, unknown>;
  requireExactKeys(entry, ['bytes', 'data', 'path', 'sha256'], label);
  if (typeof entry.path !== 'string' || typeof entry.data !== 'string') throw snapshotError(`${label} has invalid fields`, 'snapshot_invalid');
  validateBlobPath(entry.path);
  const digest = parseDigestDeclaration(entry, label, true);
  return { ...digest, path: entry.path, data: entry.data };
}

function parseDigestDeclaration(value: unknown, label: string, withPath = false): { bytes: number; sha256: string; path?: string } {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw snapshotError(`${label} must be an object`, 'snapshot_invalid');
  const declaration = value as Record<string, unknown>;
  requireExactKeys(declaration, withPath ? ['bytes', 'path', 'sha256'] : ['bytes', 'sha256'], label, withPath ? ['data'] : []);
  if (!Number.isSafeInteger(declaration.bytes) || (declaration.bytes as number) < 0
    || typeof declaration.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(declaration.sha256)) {
    throw snapshotError(`${label} has invalid integrity metadata`, 'snapshot_invalid');
  }
  if (withPath && typeof declaration.path !== 'string') throw snapshotError(`${label} has an invalid path`, 'snapshot_invalid');
  return {
    bytes: declaration.bytes as number,
    sha256: declaration.sha256,
    ...(withPath ? { path: declaration.path as string } : {}),
  };
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string, allowedExtra: readonly string[] = []): void {
  const keys = Object.keys(value).filter((key) => !allowedExtra.includes(key)).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) {
    throw snapshotError(`${label} contains unknown or missing fields`, 'snapshot_invalid');
  }
}

function decodeBase64(value: string, label: string): Buffer {
  if (value.length > Math.ceil(MAX_PAYLOAD_BYTES / 3) * 4 || !isCanonicalBase64(value)) {
    throw snapshotError(`${label} is not canonical base64`, 'snapshot_invalid');
  }
  return Buffer.from(value, 'base64');
}

function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  let padding = 0;
  if (value.endsWith('==')) padding = 2;
  else if (value.endsWith('=')) padding = 1;
  for (let index = 0; index < value.length - padding; index += 1) {
    const code = value.charCodeAt(index);
    const alphabet = (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57) || code === 43 || code === 47;
    if (!alphabet) return false;
  }
  for (let index = value.length - padding; index < value.length; index += 1) if (value.charCodeAt(index) !== 61) return false;
  return value.length === 0 || value.length - padding >= 2;
}

function requirePayloadBudget(
  databaseBytes: number,
  blobs: readonly { readonly bytes: number }[],
): void {
  let total = databaseBytes;
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_PAYLOAD_BYTES) {
    throw snapshotError('Snapshot payload exceeds the supported size limit', 'snapshot_too_large');
  }
  for (const blob of blobs) {
    if (!Number.isSafeInteger(blob.bytes) || blob.bytes < 0 || blob.bytes > MAX_PAYLOAD_BYTES - total) {
      throw snapshotError('Snapshot payload exceeds the supported size limit', 'snapshot_too_large');
    }
    total += blob.bytes;
  }
}

async function readSnapshotIdentity(databasePath: string): Promise<{
  installationId: string;
  baseIri: string;
  packages: Record<'diamond' | 'taproot' | 'workshop' | 'seedbed', string>;
}> {
  const db = new (await import('@gnolith/diamond/node-sqlite')).NodeSqliteDatabase(databasePath);
  try {
    const installation = await db.prepare('SELECT installation_id, base_iri FROM seedbed_installation WHERE singleton = 1')
      .all<{ installation_id: string; base_iri: string }>();
    const assembly = await db.prepare(`SELECT diamond_version, taproot_version, workshop_version, seedbed_version
      FROM seedbed_assembly WHERE singleton = 1`).all<{
        diamond_version: string;
        taproot_version: string;
        workshop_version: string;
        seedbed_version: string;
      }>();
    const identity = installation.results[0];
    const versions = assembly.results[0];
    if (!identity || !versions) throw snapshotError('Snapshot source identity is missing', 'snapshot_invalid');
    return {
      installationId: identity.installation_id,
      baseIri: identity.base_iri,
      packages: {
        diamond: versions.diamond_version,
        taproot: versions.taproot_version,
        workshop: versions.workshop_version,
        seedbed: versions.seedbed_version,
      },
    };
  } finally {
    await db.close();
  }
}

async function readBlobEntries(root: string, initialBytes = 0): Promise<SnapshotBlobEntry[]> {
  if (!(await pathExists(root))) return [];
  const entries: SnapshotBlobEntry[] = [];
  let payloadBytes = initialBytes;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw snapshotError('Blob storage contains a symbolic link', 'snapshot_invalid');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readBoundedFile(path, MAX_PAYLOAD_BYTES - payloadBytes, 'Snapshot blob payload');
        payloadBytes += bytes.byteLength;
        const name = relative(root, path).split(sep).join('/');
        validateBlobPath(name);
        entries.push({ path: name, bytes: bytes.byteLength, sha256: sha256(bytes), data: bytes.toString('base64') });
      } else throw snapshotError('Blob storage contains a non-regular entry', 'snapshot_invalid');
    }
  };
  await visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function readBoundedFile(path: string, maximumBytes: number, label: string): Promise<Buffer> {
  const metadata = await stat(path);
  if (maximumBytes < 0 || metadata.size > maximumBytes) {
    throw snapshotError(`${label} exceeds the supported size limit`, 'snapshot_too_large');
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > maximumBytes) throw snapshotError(`${label} exceeds the supported size limit`, 'snapshot_too_large');
  return bytes;
}

function safeBlobTarget(root: string, path: string): string {
  validateBlobPath(path);
  const target = resolve(root, ...path.split('/'));
  if (!target.startsWith(`${resolve(root)}${sep}`)) throw snapshotError('Snapshot blob path escapes its root', 'snapshot_invalid');
  return target;
}

function validateBlobPath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw snapshotError('Snapshot contains an invalid blob path', 'snapshot_invalid');
  }
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function requireMaintenancePrincipal(config: SeedbedConfig): void {
  if (!config.principalSelector || !config.workspaceSelector) {
    throw snapshotError('Snapshot maintenance requires principal and workspace selectors', 'selector_required', ExitCode.configuration);
  }
}

function snapshotError(message: string, code: string, exitCode: number = ExitCode.persistence): SeedbedError {
  return new SeedbedError(message, exitCode, code);
}

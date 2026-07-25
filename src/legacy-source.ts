import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { access, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  LegacyDecodedExport,
  LegacyDecoder,
  LegacyExportTarget,
} from './adoption.js';
import type { OwnerSection } from './owner-ports.js';
import type { LegacyLocalAdoptionManifestV1, SeedbedConfig } from './types.js';
import { canonicalJson, digestObject, sha256 } from './canonical.js';

const gunzipAsync = promisify(gunzip);
const MAX_COMPRESSED_BYTES = 192 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 192 * 1024 * 1024;
const MAX_DATABASE_BYTES = 128 * 1024 * 1024;
const MAX_BLOB_BYTES = 128 * 1024 * 1024;
const LEGACY_PACKAGES = { diamond: '0.4.1', taproot: '0.4.2', workshop: '0.4.2', seedbed: '0.3.2' } as const;

export interface PortableLegacySource {
  readonly kind: 'read-only-portable-source-v1';
  readonly databasePath: string;
  readonly blobPath: string;
  readonly offlineAttestation: 'seedbed-filesystem-sidecars-absent-v1';
}

export interface LegacyAdapterExecutor {
  invokeLegacy<T>(config: SeedbedConfig, operation: 'legacy-owner-inspect-v1' | 'legacy-owner-export-v1', source: PortableLegacySource, input: unknown): Promise<T>;
  readLegacy(config: SeedbedConfig, operation: 'legacy-taproot-payload-open-v1', source: PortableLegacySource, input: unknown): Promise<AsyncIterable<Uint8Array>>;
}

/**
 * Seedbed owns source-envelope decoding and read-only capability creation.
 * The executor owns injection of the checksum-pinned public owner adapters.
 */
export class OperatorLegacyDecoder implements LegacyDecoder {
  private prepared?: Promise<PortableLegacySource>;

  constructor(
    private readonly config: SeedbedConfig,
    private readonly executor: LegacyAdapterExecutor,
  ) {}

  async inspect(manifest: LegacyLocalAdoptionManifestV1) {
    return this.executor.invokeLegacy<Awaited<ReturnType<LegacyDecoder['inspect']>>>(
      this.config,
      'legacy-owner-inspect-v1',
      await this.prepare(manifest),
      ownerAdapterBinding(this.config),
    );
  }

  async export(manifest: LegacyLocalAdoptionManifestV1, target: LegacyExportTarget): Promise<LegacyDecodedExport> {
    const result = await this.executor.invokeLegacy<
      Omit<LegacyDecodedExport, 'sections'> & {
        sections: Array<Omit<OwnerSection, 'bytes'> & { base64: string }>;
      }
    >(
      this.config,
      'legacy-owner-export-v1',
      await this.prepare(manifest),
      { ...ownerAdapterBinding(this.config), target },
    );
    return {
      ...result,
      sections: result.sections.map(({ base64, ...section }) => ({
        ...section,
        bytes: decodeCanonicalBase64(base64, `${section.owner} legacy owner fragment`),
      })),
    };
  }

  async openPayload(manifest: LegacyLocalAdoptionManifestV1, id: string): Promise<AsyncIterable<Uint8Array>> {
    if (!id || id.length > 512) throw new TypeError('Legacy payload identifier is invalid');
    return this.executor.readLegacy(
      this.config,
      'legacy-taproot-payload-open-v1',
      await this.prepare(manifest),
      { ...ownerAdapterBinding(this.config), payloadId: id },
    );
  }

  private prepare(manifest: LegacyLocalAdoptionManifestV1): Promise<PortableLegacySource> {
    this.prepared ??= preparePortableLegacySource(manifest, this.config);
    return this.prepared;
  }
}

export async function preparePortableLegacySource(
  manifest: LegacyLocalAdoptionManifestV1,
  config: SeedbedConfig,
): Promise<PortableLegacySource> {
  if (manifest.source.kind === 'database-and-blobs') {
    const databasePath = manifest.source.databasePath!;
    const blobPath = manifest.source.blobPath!;
    await assertRegularSource(databasePath, false);
    await assertRegularSource(blobPath, true);
    const lockIndicators = [
      `${databasePath}.maintenance.lock`,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
      `${databasePath}-journal`,
    ];
    if ((await Promise.all(lockIndicators.map((path) => access(path).then(() => true).catch(() => false)))).some(Boolean)) {
      throw new TypeError('Legacy source is running, locked, or has uncheckpointed SQLite sidecars');
    }
    return {
      kind: 'read-only-portable-source-v1',
      databasePath,
      blobPath,
      offlineAttestation: 'seedbed-filesystem-sidecars-absent-v1',
    };
  }

  const snapshotPath = manifest.source.snapshotPath!;
  await assertRegularSource(snapshotPath, false);
  const compressed = await readBounded(snapshotPath, MAX_COMPRESSED_BYTES, 'Legacy snapshot');
  let parsed: unknown;
  try {
    parsed = JSON.parse((await gunzipAsync(compressed, { maxOutputLength: MAX_EXPANDED_BYTES })).toString('utf8'));
  } catch {
    throw new TypeError('Legacy snapshot is not a bounded gnolith-seedbed-snapshot-v1 envelope');
  }
  const envelope = parseSnapshotEnvelope(parsed);
  const sourceDigest = sha256(compressed);
  const root = join(config.paths.stateDirectory, 'legacy-snapshot-sources', sourceDigest);
  const databasePath = join(root, 'legacy.sqlite');
  const blobPath = join(root, 'blobs');
  await mkdir(blobPath, { recursive: true, mode: 0o700 });
  await stageExact(databasePath, envelope.database);
  for (const blob of envelope.blobs) {
    const destination = join(blobPath, ...blob.path.split('/'));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await stageExact(destination, blob.bytes);
  }
  return {
    kind: 'read-only-portable-source-v1',
    databasePath,
    blobPath,
    offlineAttestation: 'seedbed-filesystem-sidecars-absent-v1',
  };
}

function ownerAdapterBinding(config: SeedbedConfig) {
  return {
    format: 'gnolith-legacy-owner-adapter-binding-v1',
    legacyPackages: LEGACY_PACKAGES,
    adapters: {
      diamond: config.packages.diamond,
      taproot: config.packages.taproot,
      workshop: config.packages.workshop,
    },
  } as const;
}

function parseSnapshotEnvelope(value: unknown): {
  database: Uint8Array;
  blobs: readonly { path: string; bytes: Uint8Array }[];
} {
  const envelope = exactObject(value, ['blobs', 'database', 'manifest'], 'Legacy snapshot envelope');
  if (typeof envelope.database !== 'string' || !Array.isArray(envelope.blobs)) throw new TypeError('Legacy snapshot envelope payload is invalid');
  const manifest = exactObject(envelope.manifest, [
    'format', 'createdAt', 'installationId', 'baseIri', 'packages', 'database',
    'blobs', 'secretsExported', 'derivedStatePolicy',
  ], 'Legacy snapshot manifest');
  if (
    manifest.format !== 'gnolith-seedbed-snapshot-v1'
    || canonicalJson(manifest.packages) !== canonicalJson(LEGACY_PACKAGES)
    || manifest.secretsExported !== false
    || manifest.derivedStatePolicy !== 'validate-compatible-or-discard-and-rebuild'
  ) throw new TypeError('Legacy snapshot format, package tuple, or secret policy is incompatible');
  const databaseDeclaration = exactObject(manifest.database, ['bytes', 'sha256'], 'Legacy snapshot database declaration');
  const database = decodeCanonicalBase64(envelope.database, 'Legacy snapshot database');
  assertPayloadDeclaration(databaseDeclaration, database, MAX_DATABASE_BYTES, 'Legacy snapshot database');
  if (!Array.isArray(manifest.blobs) || manifest.blobs.length !== envelope.blobs.length || manifest.blobs.length > 10_000) {
    throw new TypeError('Legacy snapshot blob inventory is invalid');
  }
  const declarations = new Map<string, Record<string, unknown>>();
  for (const entry of manifest.blobs) {
    const declaration = exactObject(entry, ['path', 'bytes', 'sha256'], 'Legacy snapshot blob declaration');
    const path = safeBlobPath(declaration.path);
    if (declarations.has(path)) throw new TypeError('Legacy snapshot blob path is duplicated');
    declarations.set(path, declaration);
  }
  const blobs = envelope.blobs.map((entry) => {
    const blob = exactObject(entry, ['path', 'bytes', 'sha256', 'data'], 'Legacy snapshot blob');
    const path = safeBlobPath(blob.path);
    const declaration = declarations.get(path);
    if (!declaration || blob.bytes !== declaration.bytes || blob.sha256 !== declaration.sha256 || typeof blob.data !== 'string') {
      throw new TypeError('Legacy snapshot blob inventory does not match its manifest');
    }
    const bytes = decodeCanonicalBase64(blob.data, `Legacy snapshot blob ${path}`);
    assertPayloadDeclaration(declaration, bytes, MAX_BLOB_BYTES, `Legacy snapshot blob ${path}`);
    return { path, bytes };
  });
  return { database, blobs };
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (canonicalJson(Object.keys(record).sort()) !== canonicalJson([...keys].sort())) throw new TypeError(`${label} has unknown or missing fields`);
  return record;
}

function safeBlobPath(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 1024
    || value.includes('\\')
    || value.startsWith('/')
    || value.split('/').some((part) => !part || part === '.' || part === '..')
  ) throw new TypeError('Legacy snapshot blob path is unsafe');
  return value;
}

function decodeCanonicalBase64(value: string, label: string): Uint8Array {
  if (value.length > Math.ceil((MAX_EXPANDED_BYTES * 4) / 3) + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new TypeError(`${label} is not canonical bounded base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new TypeError(`${label} is not canonical base64`);
  return bytes;
}

function assertPayloadDeclaration(
  declaration: Record<string, unknown>,
  bytes: Uint8Array,
  maximum: number,
  label: string,
): void {
  if (
    !Number.isSafeInteger(declaration.bytes)
    || (declaration.bytes as number) < 0
    || (declaration.bytes as number) > maximum
    || declaration.bytes !== bytes.byteLength
    || typeof declaration.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(declaration.sha256)
    || declaration.sha256 !== sha256(bytes)
  ) throw new TypeError(`${label} size or digest mismatch`);
}

async function assertRegularSource(path: string, directory: boolean): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || (directory ? !metadata.isDirectory() : !metadata.isFile())) {
    throw new TypeError('Legacy source must be a regular non-link file or directory');
  }
}

async function readBounded(path: string, maximum: number, label: string): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximum) throw new TypeError(`${label} exceeds its bounds or is not a regular file`);
  return readFile(path);
}

async function stageExact(path: string, bytes: Uint8Array): Promise<void> {
  try {
    const existing = await readFile(path);
    if (sha256(existing) !== sha256(bytes)) throw new TypeError('Legacy snapshot staging collision');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  }
}

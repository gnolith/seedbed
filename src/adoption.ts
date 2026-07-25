import { lstat, readFile, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, normalize, relative, resolve } from 'node:path';
import { canonicalJson, digestObject, redactFilesystemPaths, sha256 } from './canonical.js';
import type { OwnerSection } from './owner-ports.js';
import { OWNER_LEDGER_NAMESPACES, OWNER_ORDER, type LegacyLocalAdoptionManifestV1, type OperationIssue, type SeedbedConfig } from './types.js';
import type { RestoreTarget } from './backup.js';
import { acquireOperationLock } from './operation-lock.js';

const LEGACY_TUPLE = { diamond: '0.4.1', taproot: '0.4.2', workshop: '0.4.2', seedbed: '0.3.2' } as const;

export interface AdoptionCounts {
  readonly items: number;
  readonly properties: number;
  readonly statements: number;
  readonly resources: number;
  readonly annotations: number;
  readonly tasks: number;
  readonly memories: number;
  readonly prompts: number;
  readonly revisions: number;
  readonly payloads: number;
}

export interface LegacyDecodedExport {
  readonly installationId: string;
  readonly baseIri: string;
  readonly packages: typeof LEGACY_TUPLE;
  readonly sections: readonly OwnerSection[];
  readonly counts: AdoptionCounts;
  readonly payloadDigests: readonly { id: string; bytes: number; sha256: string }[];
}

export interface LegacyDecoder {
  inspect(manifest: LegacyLocalAdoptionManifestV1): Promise<{
    installationId: string;
    baseIri: string;
    packages: typeof LEGACY_TUPLE;
    counts: AdoptionCounts;
    payloadDigests: readonly { id: string; bytes: number; sha256: string }[];
    locked: boolean;
  }>;
  export(manifest: LegacyLocalAdoptionManifestV1, target: LegacyExportTarget): Promise<LegacyDecodedExport>;
  openPayload(manifest: LegacyLocalAdoptionManifestV1, id: string): Promise<AsyncIterable<Uint8Array>>;
}

export interface LegacyExportTarget {
  readonly stagingDirectory: string;
  readonly operationId: string;
}

export interface LegacyAdoptionPlan {
  readonly format: 'gnolith-legacy-local-adoption-plan-v1';
  readonly operationId: string;
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly sourceDigests: Readonly<Record<string, string>>;
  readonly counts: AdoptionCounts;
  readonly payloadDigests: readonly { id: string; bytes: number; sha256: string }[];
}

export interface AdoptionVerification {
  readonly installationId: string;
  readonly baseIri: string;
  readonly catalogDigest: string;
  readonly counts: AdoptionCounts;
  readonly payloadDigests: readonly { id: string; bytes: number; sha256: string }[];
}

export interface AdoptionTarget extends RestoreTarget {
  importOwner(section: OwnerSection, stagingDirectory: string, operationId: string): Promise<void>;
  stagePayload(id: string, source: AsyncIterable<Uint8Array>, stagingDirectory: string, operationId: string): Promise<void>;
  collisionCheck(stagingDirectory: string, operationId: string): Promise<void>;
  rebindPayloads(stagingDirectory: string, operationId: string): Promise<void>;
  commitPayloads(stagingDirectory: string, operationId: string): Promise<void>;
  rollbackPayloads(stagingDirectory: string, operationId: string): Promise<void>;
  verify(stagingDirectory: string): Promise<AdoptionVerification>;
}

export async function loadLegacyManifest(path: string): Promise<LegacyLocalAdoptionManifestV1> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  return validateLegacyManifest(parsed);
}

export function validateLegacyManifest(value: unknown): LegacyLocalAdoptionManifestV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Legacy manifest must be an object');
  const manifest = value as Record<string, unknown>;
  exact(manifest, ['format', 'source', 'expectedInstallationId', 'expectedBaseIri', 'expectedPackages', 'targetComposeProject']);
  if (manifest.format !== 'gnolith-legacy-local-adoption-v1') throw new TypeError('Legacy manifest format is unsupported');
  const source = manifest.source as Record<string, unknown>;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new TypeError('Legacy source is invalid');
  exact(source, ['kind', 'databasePath', 'blobPath', 'snapshotPath'], ['databasePath', 'blobPath', 'snapshotPath']);
  if (!['database-and-blobs', 'seedbed-snapshot'].includes(String(source.kind))) throw new TypeError('Legacy source kind is unsupported');
  if (source.kind === 'database-and-blobs' && (typeof source.databasePath !== 'string' || typeof source.blobPath !== 'string' || source.snapshotPath !== undefined)) throw new TypeError('Database source requires only databasePath and blobPath');
  if (source.kind === 'seedbed-snapshot' && (typeof source.snapshotPath !== 'string' || source.databasePath !== undefined || source.blobPath !== undefined)) throw new TypeError('Snapshot source requires only snapshotPath');
  const expected = manifest.expectedPackages as Record<string, unknown>;
  if (!expected || canonicalJson(expected) !== canonicalJson(LEGACY_TUPLE)) throw new TypeError('Legacy package tuple must be exactly 0.4.1/0.4.2/0.4.2/0.3.2');
  for (const key of ['databasePath', 'blobPath', 'snapshotPath'] as const) {
    if (source[key] !== undefined) source[key] = safePath(String(source[key]));
  }
  return manifest as unknown as LegacyLocalAdoptionManifestV1;
}

export async function planLegacyAdoption(input: {
  manifest: LegacyLocalAdoptionManifestV1;
  config: SeedbedConfig;
  decoder: LegacyDecoder;
}): Promise<LegacyAdoptionPlan> {
  if (input.manifest.targetComposeProject !== input.config.compose.projectName) throw new TypeError('Legacy target Compose project does not match configuration');
  const source = await input.decoder.inspect(input.manifest);
  assertSourceIdentity(input.manifest, source);
  if (source.locked !== false) throw new TypeError('Legacy source is running, locked, or lacks an explicit offline attestation');
  validateCountsAndPayloads(source.counts, source.payloadDigests, input.config.backup.maxBlobBytes);
  const sourceDigests = await digestSources(input.manifest, input.config);
  const body = {
    format: 'gnolith-legacy-local-adoption-plan-v1' as const,
    manifestDigest: digestObject(input.manifest),
    configDigest: digestObject(input.config),
    sourceDigests,
    counts: source.counts,
    payloadDigests: source.payloadDigests,
  };
  return { ...body, operationId: digestObject(body) };
}

export async function applyLegacyAdoption(input: {
  manifest: LegacyLocalAdoptionManifestV1;
  plan: LegacyAdoptionPlan;
  config: SeedbedConfig;
  decoder: LegacyDecoder;
  target: AdoptionTarget;
  interruptAfter?: string;
}): Promise<{ operationId: string; issues: readonly OperationIssue[]; verification: AdoptionVerification }> {
  const current = await planLegacyAdoption(input);
  if (canonicalJson(current) !== canonicalJson(input.plan)) throw new TypeError('Adoption plan is stale or source/config digests changed');
  const lock = await acquireOperationLock(join(input.config.paths.stateDirectory, 'operations', 'installation-operation.lock'), input.plan.operationId);
  try {
    if (!(await input.target.isEmpty())) throw new TypeError('Adoption target must be empty');
    const staging = await input.target.stagingDirectory(input.plan.operationId);
    try {
      const exported = await input.decoder.export(input.manifest, {
        stagingDirectory: staging,
        operationId: input.plan.operationId,
      });
      assertSourceIdentity(input.manifest, exported);
      validateCountsAndPayloads(exported.counts, exported.payloadDigests, input.config.backup.maxBlobBytes);
      validateOwnerSections(exported.sections, input.config.backup.maxArchiveBytes);
      if (canonicalJson(exported.counts) !== canonicalJson(input.plan.counts) || canonicalJson(exported.payloadDigests) !== canonicalJson(input.plan.payloadDigests)) throw new TypeError('Legacy source changed after planning');
      if (sumCounts(exported.counts) > 0 && exported.sections.every((section) => section.bytes.byteLength === 0)) throw new TypeError('Nonempty legacy source exported empty owner sections');
      for (const payload of exported.payloadDigests) {
        const source = await input.decoder.openPayload(input.manifest, payload.id);
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for await (const chunk of source) {
          bytes += chunk.byteLength;
          if (bytes > payload.bytes || bytes > input.config.backup.maxBlobBytes) throw new TypeError(`Legacy payload ${payload.id} exceeds declared bounds`);
          chunks.push(chunk);
        }
        const combined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
        if (combined.byteLength !== payload.bytes || sha256(combined) !== payload.sha256) throw new TypeError(`Legacy payload ${payload.id} digest or size mismatch`);
        async function* verifiedSource() { yield combined; }
        await input.target.stagePayload(payload.id, verifiedSource(), staging, input.plan.operationId);
      }
      await input.target.collisionCheck(staging, input.plan.operationId);
      await input.target.rebindPayloads(staging, input.plan.operationId);
      if (input.interruptAfter === 'payloads') throw new Error('test interruption after payloads');
      for (const owner of OWNER_ORDER) {
        const section = exported.sections.find((entry) => entry.owner === owner);
        if (!section || section.ledger.namespace !== OWNER_LEDGER_NAMESPACES[owner]) throw new TypeError(`${owner} legacy export lacks namespace-sliced ledger evidence`);
        // The staging target validates and imports through the owner's public
        // API against its live staging ledger. A separate default-database
        // validation would address the wrong database during offline adoption.
        await input.target.importOwner(section, staging, input.plan.operationId);
        if (input.interruptAfter === owner) throw new Error(`test interruption after ${owner}`);
      }
      const verification = await input.target.verify(staging);
      if (
        verification.installationId !== input.manifest.expectedInstallationId
        || verification.baseIri !== input.manifest.expectedBaseIri
        || verification.catalogDigest !== input.config.migrations.expectedCatalogDigest
        || canonicalJson(verification.counts) !== canonicalJson(exported.counts)
        || canonicalJson(verification.payloadDigests) !== canonicalJson(exported.payloadDigests)
      ) throw new TypeError('Adoption verification detected identity, catalog, count, or payload loss');
      if (canonicalJson(await digestSources(input.manifest, input.config)) !== canonicalJson(input.plan.sourceDigests)) throw new TypeError('Legacy source changed during adoption');
      await input.target.commitPayloads(staging, input.plan.operationId);
      await input.target.exposeDatabaseLast(staging, input.plan.operationId);
      return { operationId: input.plan.operationId, issues: [], verification };
    } catch (error) {
      await input.target.rollbackPayloads(staging, input.plan.operationId).catch(() => undefined);
      await input.target.cleanup(staging).catch(() => undefined);
      throw adoptionError(error);
    }
  } finally {
    await lock.release();
  }
}

function assertSourceIdentity(manifest: LegacyLocalAdoptionManifestV1, source: { installationId: string; baseIri: string; packages: typeof LEGACY_TUPLE }): void {
  if (source.installationId !== manifest.expectedInstallationId || source.baseIri !== manifest.expectedBaseIri || canonicalJson(source.packages) !== canonicalJson(LEGACY_TUPLE)) {
    throw new TypeError('Legacy source identity or exact package tuple is incompatible');
  }
}

async function digestSources(manifest: LegacyLocalAdoptionManifestV1, config: SeedbedConfig): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(manifest.source)) {
    if (key === 'kind' || typeof value !== 'string') continue;
    const metadata = await lstat(value);
    if (metadata.isSymbolicLink()) throw new TypeError('Legacy sources must not be symbolic links or junctions');
    if (metadata.isFile()) {
      if (metadata.size > config.backup.maxArchiveBytes) throw new TypeError('Legacy source file exceeds configured adoption bounds');
      result[key] = await digestFile(value);
    } else if (metadata.isDirectory()) result[key] = await digestDirectory(value, config.backup.maxBlobBytes, config.backup.maxArchiveBytes);
    else throw new TypeError('Legacy source must be a regular file or directory');
  }
  return result;
}

async function digestDirectory(root: string, maxFileBytes: number, maxTotalBytes: number): Promise<string> {
  const records: { path: string; bytes: number; sha256: string }[] = [];
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (records.length >= 10_000) throw new TypeError('Legacy blob directory exceeds 10000 files');
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new TypeError('Legacy blob directory must not contain links or junctions');
      if (metadata.isDirectory()) await visit(path);
      else if (metadata.isFile()) {
        totalBytes += metadata.size;
        if (metadata.size > maxFileBytes || totalBytes > maxTotalBytes) throw new TypeError('Legacy blob directory exceeds configured adoption bounds');
        records.push({
          path: relative(root, path).replaceAll('\\', '/'),
          bytes: metadata.size,
          sha256: await digestFile(path),
        });
      }
      else throw new TypeError('Legacy blob directory contains an unsupported entry');
    }
  };
  await visit(root);
  return digestObject(records);
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function safePath(value: string): string {
  const path = normalize(resolve(value));
  const colonUnsafe = process.platform === 'win32'
    ? path.slice(2).includes(':')
    : path.includes(':');
  if (/^\\\\/u.test(path) || /[\0\r\n]/u.test(value) || colonUnsafe) throw new TypeError('Legacy source path must be a local Docker-bind-safe path');
  return path;
}

function sumCounts(counts: AdoptionCounts): number {
  return Object.values(counts).reduce((sum, count) => {
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('Legacy source count is invalid');
    return sum + count;
  }, 0);
}

function validateCountsAndPayloads(
  counts: AdoptionCounts,
  payloads: readonly { id: string; bytes: number; sha256: string }[],
  maxBlobBytes: number,
): void {
  sumCounts(counts);
  if (payloads.length !== counts.payloads || payloads.length > 10_000) throw new TypeError('Legacy payload inventory count is invalid');
  const ids = new Set<string>();
  for (const payload of payloads) {
    if (!payload.id || payload.id.length > 512 || ids.has(payload.id)) throw new TypeError('Legacy payload inventory has invalid or duplicate identifiers');
    if (!Number.isSafeInteger(payload.bytes) || payload.bytes < 0 || payload.bytes > maxBlobBytes) throw new TypeError(`Legacy payload ${payload.id} has invalid bounds`);
    if (!/^[0-9a-f]{64}$/u.test(payload.sha256)) throw new TypeError(`Legacy payload ${payload.id} has an invalid digest`);
    ids.add(payload.id);
  }
}

function validateOwnerSections(sections: readonly OwnerSection[], maxBytes: number): void {
  if (sections.length !== OWNER_ORDER.length) throw new TypeError('Legacy export must contain exactly one section per owner');
  let totalBytes = 0;
  for (const owner of OWNER_ORDER) {
    const matching = sections.filter((section) => section.owner === owner);
    const section = matching[0];
    if (
      matching.length !== 1
      || !section
      || section.ledger.namespace !== OWNER_LEDGER_NAMESPACES[owner]
      || typeof section.schemaVersion !== 'string'
      || section.schemaVersion.length === 0
      || section.schemaVersion.length > 256
      || !['retained', 'rebuildable', 'deferred'].includes(section.disposition)
      || typeof section.ledger.schemaVersion !== 'string'
      || section.ledger.schemaVersion.length === 0
      || section.ledger.schemaVersion.length > 256
      || !/^[0-9a-f]{64}$/u.test(section.ledger.digest)
    ) {
      throw new TypeError(`${owner} legacy export lacks exactly one namespace-sliced ledger section`);
    }
    totalBytes += section.bytes.byteLength;
    if (totalBytes > maxBytes) throw new TypeError('Legacy owner fragments exceed configured adoption bounds');
  }
}

function adoptionError(error: unknown): Error {
  const message = error instanceof Error ? error.message : 'Legacy adoption failed';
  return new TypeError(JSON.stringify({
    issues: [{
      code: 'legacy_adoption_failed',
      phase: 'staging',
      remediation: 'Correct the owner-local compatibility condition and rerun the unchanged digest-bound plan.',
    }],
    message: redactFilesystemPaths(message.slice(0, 2048)),
  }));
}

function exact(record: Record<string, unknown>, allowed: readonly string[], optional: readonly string[] = []): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !optional.includes(key) && !(key in record));
  if (unknown.length || missing.length) throw new TypeError('Legacy manifest has unknown or missing fields');
}

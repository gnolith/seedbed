import { link, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalJson, digestObject, sha256 } from './canonical.js';
import { OWNER_LEDGER_NAMESPACES, OWNER_ORDER, type InstallationBackupManifest, type RetentionReport, type SeedbedConfig } from './types.js';
import type { BlobDescriptor, InstallationPorts, OwnerSection } from './owner-ports.js';
import { acquireOperationLock } from './operation-lock.js';

interface BackupEnvelope {
  readonly format: 'gnolith-installation-backup-v1';
  readonly manifest: InstallationBackupManifest;
  readonly sections: readonly {
    readonly owner: string;
    readonly ledger: OwnerSection['ledger'];
    readonly base64: string;
  }[];
  readonly blobs: readonly { readonly id: string; readonly ownerDescriptorBase64: string; readonly base64: string }[];
}

export interface RestoreTarget {
  isEmpty(): Promise<boolean>;
  stagingDirectory(operationId: string): Promise<string>;
  exposeDatabaseLast(stagingDirectory: string, operationId: string): Promise<void>;
  cleanup(stagingDirectory: string): Promise<void>;
}

export interface BackupInspection {
  readonly valid: boolean;
  readonly manifest: InstallationBackupManifest;
  readonly archiveSha256: string;
  readonly bytes: number;
  readonly retention: RetentionReport;
}

export async function createInstallationBackup(input: {
  config: SeedbedConfig;
  ports: InstallationPorts;
  destination: string;
  now?: () => Date;
}): Promise<BackupInspection> {
  const sections: OwnerSection[] = [];
  for (const owner of OWNER_ORDER) {
    const inspected = await input.ports[owner].inspectBackup();
    const section = await input.ports[owner].exportBackup();
    assertSection(section, owner);
    if (section.schemaVersion !== inspected.schemaVersion || section.ledger.digest !== inspected.ledger.digest) {
      throw new TypeError(`${owner} backup changed between inspect and export`);
    }
    sections.push(section);
  }
  const blobs: { descriptor: BlobDescriptor; bytes: Uint8Array }[] = [];
  let totalBlobBytes = 0;
  for await (const descriptor of input.ports.blobs.enumerate(10_000)) {
    if (blobs.length >= 10_000) throw new TypeError('Blob enumeration exceeds 10000 entries');
    if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(descriptor.id)) throw new TypeError('Blob identifier is invalid');
    if (!Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0 || descriptor.bytes > input.config.backup.maxBlobBytes) throw new TypeError(`Blob ${descriptor.id} exceeds configured bounds`);
    if (!(descriptor.ownerDescriptor instanceof Uint8Array) || descriptor.ownerDescriptor.byteLength === 0 || descriptor.ownerDescriptor.byteLength > 1024 * 1024) throw new TypeError(`Blob ${descriptor.id} owner descriptor is invalid`);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of await input.ports.blobs.open(descriptor)) {
      bytes += chunk.byteLength;
      totalBlobBytes += chunk.byteLength;
      if (bytes > descriptor.bytes || totalBlobBytes > input.config.backup.maxArchiveBytes) throw new TypeError('Blob stream exceeds declared or archive bounds');
      chunks.push(Buffer.from(chunk));
    }
    const value = Buffer.concat(chunks);
    if (bytes !== descriptor.bytes || sha256(value) !== descriptor.sha256) throw new TypeError(`Blob ${descriptor.id} digest or size mismatch`);
    blobs.push({ descriptor, bytes: value });
  }
  const manifest: InstallationBackupManifest = {
    formatVersion: 1,
    installationId: input.config.installationId,
    baseIri: input.config.baseIri,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    packageVersions: Object.fromEntries(OWNER_ORDER.map((owner) => [owner, input.config.packages[owner].version])),
    sections: sections.map((section) => ({
      owner: section.owner,
      schemaVersion: section.schemaVersion,
      sha256: sha256(section.bytes),
      disposition: section.disposition,
    })),
    blobs: blobs.map(({ descriptor }) => ({ id: descriptor.id, bytes: descriptor.bytes, sha256: descriptor.sha256 })),
  };
  const envelope: BackupEnvelope = {
    format: 'gnolith-installation-backup-v1',
    manifest,
    sections: sections.map((section) => ({
      owner: section.owner,
      ledger: section.ledger,
      base64: Buffer.from(section.bytes).toString('base64'),
    })),
    blobs: blobs.map(({ descriptor, bytes }) => ({
      id: descriptor.id,
      ownerDescriptorBase64: Buffer.from(descriptor.ownerDescriptor).toString('base64'),
      base64: Buffer.from(bytes).toString('base64'),
    })),
  };
  const encoded = Buffer.from(`${canonicalJson(envelope)}\n`);
  if (encoded.byteLength > input.config.backup.maxArchiveBytes) throw new TypeError('Backup envelope exceeds configured archive bound');
  await exclusiveWrite(input.destination, encoded);
  const inspection = await inspectInstallationBackup(input.destination, input.config);
  if (!inspection.valid) throw new TypeError('Newly created backup did not pass full inspection');
  return inspection;
}

export async function inspectInstallationBackup(path: string, config: SeedbedConfig): Promise<BackupInspection> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > config.backup.maxArchiveBytes) throw new TypeError('Backup is not a bounded regular file');
  const bytes = await readFile(path);
  const envelope = parseEnvelope(bytes, config);
  return {
    valid: true,
    manifest: envelope.manifest,
    archiveSha256: sha256(bytes),
    bytes: bytes.byteLength,
    retention: retentionReport(),
  };
}

export async function verifyInstallationBackup(path: string, config: SeedbedConfig, ports: InstallationPorts): Promise<BackupInspection> {
  const inspection = await inspectInstallationBackup(path, config);
  const envelope = parseEnvelope(await readFile(path), config);
  const reports: Partial<RetentionReport>[] = [];
  for (const owner of OWNER_ORDER) {
    const section = materializeSection(envelope, owner, config.backup.maxArchiveBytes);
    reports.push(await ports[owner].validateBackup(section));
  }
  return { ...inspection, retention: mergeRetention(inspection.retention, reports) };
}

export async function dryRunRestore(path: string, config: SeedbedConfig, ports: InstallationPorts): Promise<BackupInspection> {
  return verifyInstallationBackup(path, config, ports);
}

export async function restoreInstallationBackup(input: {
  path: string;
  config: SeedbedConfig;
  ports: InstallationPorts;
  target: RestoreTarget;
  interruptAfter?: string;
}): Promise<BackupInspection> {
  const inspection = await verifyInstallationBackup(input.path, input.config, input.ports);
  if (inspection.manifest.installationId !== input.config.installationId || inspection.manifest.baseIri !== input.config.baseIri) throw new TypeError('Backup identity does not match target configuration');
  const envelope = parseEnvelope(await readFile(input.path), input.config);
  const operationId = digestObject({ restore: inspection.archiveSha256, config: digestObject(input.config) });
  const lock = await acquireOperationLock(join(input.config.paths.stateDirectory, 'operations', 'installation-operation.lock'), operationId);
  try {
    if (!(await input.target.isEmpty())) throw new TypeError('Restore target must be empty');
    const staging = await input.target.stagingDirectory(operationId);
    try {
      for (const blob of envelope.blobs) {
        const bytes = decodeBase64(blob.base64, input.config.backup.maxBlobBytes, `Blob ${blob.id}`);
        const declaration = envelope.manifest.blobs.find((entry) => entry.id === blob.id)!;
        const ownerDescriptor = decodeBase64(blob.ownerDescriptorBase64, 1024 * 1024, `Blob ${blob.id} owner descriptor`);
        async function* source() { yield bytes; }
        await input.ports.blobs.stage({ ...declaration, ownerDescriptor }, source(), staging);
      }
      await input.ports.blobs.collisionCheck(staging);
      await input.ports.blobs.rebind(staging);
      if (input.interruptAfter === 'blobs-rebound') throw new Error('test interruption after blobs-rebound');
      for (const owner of OWNER_ORDER) {
        await input.ports[owner].importBackup(materializeSection(envelope, owner, input.config.backup.maxArchiveBytes), staging, operationId);
        if (input.interruptAfter === owner) throw new Error(`test interruption after ${owner}`);
      }
      await input.ports.blobs.commit(staging);
      if (input.interruptAfter === 'blobs-committed') throw new Error('test interruption after blobs-committed');
      await input.target.exposeDatabaseLast(staging, operationId);
      return inspection;
    } catch (error) {
      await input.ports.blobs.rollback(staging).catch(() => undefined);
      await input.target.cleanup(staging).catch(() => undefined);
      throw error;
    }
  } finally {
    await lock.release();
  }
}

function parseEnvelope(bytes: Uint8Array, config: SeedbedConfig): BackupEnvelope {
  if (bytes.byteLength > config.backup.maxArchiveBytes) throw new TypeError('Backup exceeds configured archive bound');
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new TypeError('Backup must be bounded UTF-8 JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Backup envelope is invalid');
  if (text !== `${canonicalJson(value)}\n`) throw new TypeError('Backup envelope is not canonical JSON');
  const envelope = value as BackupEnvelope;
  exactKeys(envelope as unknown as Record<string, unknown>, ['format', 'manifest', 'sections', 'blobs'], 'Backup envelope');
  if (envelope.format !== 'gnolith-installation-backup-v1' || envelope.manifest?.formatVersion !== 1) throw new TypeError('Backup format is unsupported');
  const manifest = envelope.manifest as unknown as Record<string, unknown>;
  exactKeys(manifest, ['formatVersion', 'installationId', 'baseIri', 'createdAt', 'packageVersions', 'sections', 'blobs'], 'Backup manifest');
  if (
    typeof envelope.manifest.installationId !== 'string'
    || envelope.manifest.installationId.length === 0
    || envelope.manifest.installationId.length > 128
    || typeof envelope.manifest.baseIri !== 'string'
    || envelope.manifest.baseIri.length > 2048
    || typeof envelope.manifest.createdAt !== 'string'
    || !isCanonicalTimestamp(envelope.manifest.createdAt)
  ) throw new TypeError('Backup manifest identity or timestamp is invalid');
  const expectedVersions = Object.fromEntries(OWNER_ORDER.map((owner) => [owner, config.packages[owner].version]));
  if (canonicalJson(envelope.manifest.packageVersions) !== canonicalJson(expectedVersions)) throw new TypeError('Backup package versions are incompatible');
  if (!Array.isArray(envelope.sections) || envelope.sections.length !== OWNER_ORDER.length || !Array.isArray(envelope.blobs) || envelope.blobs.length > 10_000) throw new TypeError('Backup section/blob inventory is invalid');
  if (!Array.isArray(envelope.manifest.sections) || envelope.manifest.sections.length !== OWNER_ORDER.length || !Array.isArray(envelope.manifest.blobs) || envelope.manifest.blobs.length !== envelope.blobs.length) throw new TypeError('Backup manifest inventory is invalid');
  const owners = envelope.sections.map((entry) => entry.owner);
  if (canonicalJson(owners) !== canonicalJson(OWNER_ORDER)) throw new TypeError('Backup sections are duplicated, missing, or out of owner order');
  for (const owner of OWNER_ORDER) {
    const encoded = envelope.sections.find((entry) => entry.owner === owner) as unknown as Record<string, unknown>;
    exactKeys(encoded, ['owner', 'ledger', 'base64'], `${owner} encoded backup section`);
    const section = materializeSection(envelope, owner, config.backup.maxArchiveBytes);
    const declaration = envelope.manifest.sections.find((entry) => entry.owner === owner);
    if (!declaration) throw new TypeError(`${owner} section declaration is missing`);
    exactKeys(declaration as unknown as Record<string, unknown>, ['owner', 'schemaVersion', 'sha256', 'disposition'], `${owner} backup section declaration`);
    if (
      declaration.sha256 !== sha256(section.bytes)
      || !/^[0-9a-f]{64}$/u.test(declaration.sha256)
      || declaration.schemaVersion !== section.schemaVersion
      || !['retained', 'rebuildable', 'deferred'].includes(declaration.disposition)
    ) throw new TypeError(`${owner} section checksum, schema, or disposition mismatch`);
    assertSection(section, owner);
  }
  const ids = new Set<string>();
  for (const entry of envelope.blobs) {
    exactKeys(entry as unknown as Record<string, unknown>, ['id', 'ownerDescriptorBase64', 'base64'], 'Encoded backup blob');
    const ownerDescriptor = decodeBase64(entry.ownerDescriptorBase64, 1024 * 1024, `Blob ${entry.id} owner descriptor`);
    if (ownerDescriptor.byteLength === 0) throw new TypeError('Backup blob owner descriptor is empty');
    if (typeof entry.id !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/u.test(entry.id) || ids.has(entry.id)) throw new TypeError('Backup contains invalid or duplicate blob identifiers');
    ids.add(entry.id);
    const manifest = envelope.manifest.blobs.find((blob) => blob.id === entry.id);
    if (!manifest) throw new TypeError(`Blob ${entry.id} manifest entry is missing`);
    exactKeys(manifest as unknown as Record<string, unknown>, ['id', 'bytes', 'sha256'], `Blob ${entry.id} manifest entry`);
    const decoded = decodeBase64(entry.base64, config.backup.maxBlobBytes, `Blob ${entry.id}`);
    if (
      !Number.isSafeInteger(manifest.bytes)
      || manifest.bytes < 0
      || manifest.bytes !== decoded.byteLength
      || manifest.bytes > config.backup.maxBlobBytes
      || !/^[0-9a-f]{64}$/u.test(manifest.sha256)
      || manifest.sha256 !== sha256(decoded)
    ) throw new TypeError(`Blob ${entry.id} checksum or size mismatch`);
  }
  if (envelope.manifest.blobs.some((blob) => !ids.has(blob.id))) throw new TypeError('Backup manifest contains an undeclared blob payload');
  return envelope;
}

function materializeSection(envelope: BackupEnvelope, owner: typeof OWNER_ORDER[number], maxBytes: number): OwnerSection {
  const encoded = envelope.sections.find((entry) => entry.owner === owner);
  const manifest = envelope.manifest.sections.find((entry) => entry.owner === owner);
  if (!encoded || !manifest) throw new TypeError(`Backup is missing ${owner}`);
  return {
    owner,
    schemaVersion: manifest.schemaVersion,
    disposition: manifest.disposition,
    ledger: encoded.ledger,
    bytes: decodeBase64(encoded.base64, maxBytes, `${owner} section`),
  };
}

function assertSection(section: OwnerSection, owner: typeof OWNER_ORDER[number]): void {
  exactKeys(section.ledger as unknown as Record<string, unknown>, ['namespace', 'schemaVersion', 'digest'], `${owner} ledger evidence`);
  if (
    section.owner !== owner
    || section.ledger.namespace !== OWNER_LEDGER_NAMESPACES[owner]
    || typeof section.ledger.schemaVersion !== 'string'
    || section.ledger.schemaVersion.length === 0
    || section.ledger.schemaVersion.length > 256
    || !/^[0-9a-f]{64}$/u.test(section.ledger.digest)
  ) throw new TypeError(`${owner} section has invalid namespace-sliced ledger evidence`);
}

function retentionReport(): RetentionReport {
  return {
    retained: [
      'canonical Items, Properties, Statements, Resources, Annotations, Tasks, Memories, and Prompts',
      'revisions, attribution, authorization, audit, and blob payloads',
      'semantic configuration metadata, exclusions, plans, schedules, and usage (credentials excluded)',
    ],
    rebuildable: ['RDF projections', 'lexical projections', 'chunks', 'embeddings', 'vector indexes'],
    deferred: ['legacy onboarding rows unsupported by the selected owner import ports'],
    expired: ['live task leases'],
    unsupported: [],
  };
}

function mergeRetention(base: RetentionReport, reports: readonly Partial<RetentionReport>[]): RetentionReport {
  const fields = ['retained', 'rebuildable', 'deferred', 'expired', 'unsupported'] as const;
  return Object.fromEntries(fields.map((field) => [
    field,
    [...new Set([...(base[field] ?? []), ...reports.flatMap((report) => report[field] ?? [])])].slice(0, 1000),
  ])) as unknown as RetentionReport;
}

async function exclusiveWrite(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    await rm(temporary);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function decodeBase64(value: unknown, maxBytes: number, label: string): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new TypeError(`${label} is not bounded canonical base64`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength > maxBytes || decoded.toString('base64') !== value) throw new TypeError(`${label} is not bounded canonical base64`);
  return decoded;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (canonicalJson(Object.keys(record).sort()) !== canonicalJson([...expected].sort())) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}

function isCanonicalTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

import { OWNER_LEDGER_NAMESPACES, type OwnerDiagnostic, type OwnerLedgerEvidence, type OwnerName, type RetentionReport, type SeedbedConfig } from './types.js';

export interface OwnerSection {
  readonly owner: OwnerName;
  readonly schemaVersion: string;
  readonly disposition: 'retained' | 'rebuildable' | 'deferred';
  readonly ledger: OwnerLedgerEvidence;
  readonly bytes: Uint8Array;
}

export interface BlobDescriptor {
  readonly id: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Opaque package-owned descriptor carried unchanged into staged restore. */
  readonly ownerDescriptor: Uint8Array;
}

export interface OwnerPort {
  readonly owner: OwnerName;
  planMigration(expectedVersion: string): Promise<{ current: string | null; target: string; digest: string }>;
  applyMigration(expectedVersion: string, operationId: string): Promise<OwnerDiagnostic>;
  diagnose(): Promise<OwnerDiagnostic>;
  inspectBackup(): Promise<{ schemaVersion: string; disposition: OwnerSection['disposition']; ledger: OwnerLedgerEvidence }>;
  exportBackup(): Promise<OwnerSection>;
  validateBackup(section: OwnerSection): Promise<Partial<RetentionReport>>;
  importBackup(section: OwnerSection, stagingDirectory: string, operationId: string): Promise<void>;
}

export interface WorkshopOwnerPort extends OwnerPort {
  readonly owner: 'workshop';
  bootstrapV1(input: {
    installationId: string;
    baseIri: string;
    credentialId: string;
    tokenFile: string;
    operationId: string;
  }): Promise<{
    installationId: string;
    baseIri: string;
    catalogDigest: string;
    credentialId: string;
    credentialDigest: string;
  }>;
}

export interface TaprootBlobPort {
  enumerate(limit: number): AsyncIterable<BlobDescriptor>;
  open(descriptor: BlobDescriptor): Promise<AsyncIterable<Uint8Array>>;
  stage(descriptor: BlobDescriptor, source: AsyncIterable<Uint8Array>, stagingDirectory: string): Promise<void>;
  collisionCheck(stagingDirectory: string): Promise<void>;
  rebind(stagingDirectory: string): Promise<void>;
  commit(stagingDirectory: string): Promise<void>;
  rollback(stagingDirectory: string): Promise<void>;
}

export interface InstallationPorts {
  readonly diamond: OwnerPort;
  readonly taproot: OwnerPort;
  readonly workshop: WorkshopOwnerPort;
  readonly blobs: TaprootBlobPort;
}

export interface SeedbedOperatorExecutor {
  invoke<T>(config: SeedbedConfig, operation: string, input: unknown): Promise<T>;
  read(config: SeedbedConfig, operation: string, input: unknown): Promise<AsyncIterable<Uint8Array>>;
  write(config: SeedbedConfig, operation: string, input: unknown, source: AsyncIterable<Uint8Array>): Promise<void>;
}

interface EncodedOwnerSection {
  readonly owner: OwnerName;
  readonly schemaVersion: string;
  readonly disposition: OwnerSection['disposition'];
  readonly ledger: OwnerLedgerEvidence;
  readonly base64: string;
}

export class OperatorOwnerPort implements OwnerPort {
  constructor(readonly owner: OwnerName, protected readonly config: SeedbedConfig, protected readonly executor: SeedbedOperatorExecutor) {}

  async planMigration(expectedVersion: string) {
    return this.executor.invoke<{ current: string | null; target: string; digest: string }>(this.config, 'owner-migration-plan-v1', { owner: this.owner, expectedVersion });
  }

  async applyMigration(expectedVersion: string, operationId: string) {
    return this.executor.invoke<OwnerDiagnostic>(this.config, 'owner-migration-apply-v1', { owner: this.owner, expectedVersion, operationId });
  }

  async diagnose() {
    return this.executor.invoke<OwnerDiagnostic>(this.config, 'owner-diagnostics-v1', { owner: this.owner });
  }

  async inspectBackup() {
    return this.executor.invoke<{ schemaVersion: string; disposition: OwnerSection['disposition']; ledger: OwnerLedgerEvidence }>(this.config, 'owner-backup-inspect-v1', { owner: this.owner });
  }

  async exportBackup() {
    return decodeSection(await this.executor.invoke<EncodedOwnerSection>(this.config, 'owner-backup-export-v1', { owner: this.owner }));
  }

  async validateBackup(section: OwnerSection) {
    return this.executor.invoke<Partial<RetentionReport>>(this.config, 'owner-backup-validate-v1', { section: encodeSection(section) });
  }

  async importBackup(section: OwnerSection, stagingDirectory: string, operationId: string) {
    await this.executor.invoke(this.config, 'owner-backup-import-v1', { section: encodeSection(section), stagingDirectory, operationId });
  }
}

export class OperatorWorkshopOwnerPort extends OperatorOwnerPort implements WorkshopOwnerPort {
  readonly owner = 'workshop' as const;
  constructor(config: SeedbedConfig, executor: SeedbedOperatorExecutor) {
    super('workshop', config, executor);
  }

  async bootstrapV1(input: Parameters<WorkshopOwnerPort['bootstrapV1']>[0]) {
    return this.executor.invoke<{
      installationId: string;
      baseIri: string;
      catalogDigest: string;
      credentialId: string;
      credentialDigest: string;
    }>(this.config, 'workshop-bootstrap-v1', {
      ...input,
      tokenFile: '/run/secrets/gnolith-bearer',
    });
  }
}

export class OperatorTaprootBlobPort implements TaprootBlobPort {
  constructor(private readonly config: SeedbedConfig, private readonly executor: SeedbedOperatorExecutor) {}

  async *enumerate(limit: number): AsyncIterable<BlobDescriptor> {
    const result = await this.executor.invoke<{ blobs: {
      id: string;
      bytes: number;
      sha256: string;
      ownerDescriptorBase64: string;
    }[] }>(this.config, 'taproot-blob-enumerate-v1', { limit });
    if (!Array.isArray(result.blobs) || result.blobs.length > limit) throw new TypeError('Blob enumeration response is invalid');
    for (const blob of result.blobs) {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(blob.ownerDescriptorBase64)) throw new TypeError('Blob owner descriptor is not canonical base64');
      const ownerDescriptor = Buffer.from(blob.ownerDescriptorBase64, 'base64');
      if (ownerDescriptor.byteLength === 0 || ownerDescriptor.byteLength > 1024 * 1024 || ownerDescriptor.toString('base64') !== blob.ownerDescriptorBase64) {
        throw new TypeError('Blob owner descriptor is invalid');
      }
      yield { id: blob.id, bytes: blob.bytes, sha256: blob.sha256, ownerDescriptor };
    }
  }

  async open(descriptor: BlobDescriptor): Promise<AsyncIterable<Uint8Array>> {
    return this.executor.read(this.config, 'taproot-blob-open-v1', {
      id: descriptor.id,
      ownerDescriptorBase64: Buffer.from(descriptor.ownerDescriptor).toString('base64'),
    });
  }

  async stage(descriptor: BlobDescriptor, source: AsyncIterable<Uint8Array>, stagingDirectory: string): Promise<void> {
    await this.executor.write(this.config, 'taproot-blob-stage-v1', {
      id: descriptor.id,
      bytes: descriptor.bytes,
      sha256: descriptor.sha256,
      ownerDescriptorBase64: Buffer.from(descriptor.ownerDescriptor).toString('base64'),
      stagingDirectory,
    }, source);
  }

  async collisionCheck(stagingDirectory: string) { await this.executor.invoke(this.config, 'taproot-blob-collision-check-v1', { stagingDirectory }); }
  async rebind(stagingDirectory: string) { await this.executor.invoke(this.config, 'taproot-blob-rebind-v1', { stagingDirectory }); }
  async commit(stagingDirectory: string) { await this.executor.invoke(this.config, 'taproot-blob-commit-v1', { stagingDirectory }); }
  async rollback(stagingDirectory: string) { await this.executor.invoke(this.config, 'taproot-blob-rollback-v1', { stagingDirectory }); }
}

export function createOperatorOwnerPorts(_config: SeedbedConfig, executor: SeedbedOperatorExecutor): InstallationPorts {
  return {
    diamond: new OperatorOwnerPort('diamond', _config, executor),
    taproot: new OperatorOwnerPort('taproot', _config, executor),
    workshop: new OperatorWorkshopOwnerPort(_config, executor),
    blobs: new OperatorTaprootBlobPort(_config, executor),
  };
}

function encodeSection(section: OwnerSection): EncodedOwnerSection {
  return {
    owner: section.owner,
    schemaVersion: section.schemaVersion,
    disposition: section.disposition,
    ledger: section.ledger,
    base64: Buffer.from(section.bytes).toString('base64'),
  };
}

function decodeSection(section: EncodedOwnerSection): OwnerSection {
  if (!section || typeof section !== 'object') throw new TypeError('Owner section response is invalid');
  const keys = Object.keys(section as unknown as Record<string, unknown>).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['base64', 'disposition', 'ledger', 'owner', 'schemaVersion'])) throw new TypeError('Owner section response has unknown or missing fields');
  if (
    !OWNER_NAMES.has(section.owner)
    || typeof section.schemaVersion !== 'string'
    || section.schemaVersion.length === 0
    || section.schemaVersion.length > 256
    || !['retained', 'rebuildable', 'deferred'].includes(section.disposition)
    || !section.ledger
    || section.ledger.namespace !== OWNER_LEDGER_NAMESPACES[section.owner]
    || typeof section.ledger.schemaVersion !== 'string'
    || !/^[0-9a-f]{64}$/u.test(section.ledger.digest)
  ) throw new TypeError('Owner section response metadata is invalid');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(section.base64)) throw new TypeError('Owner section response is not canonical base64');
  const bytes = Buffer.from(section.base64, 'base64');
  if (bytes.toString('base64') !== section.base64) throw new TypeError('Owner section response is not canonical base64');
  return { owner: section.owner, schemaVersion: section.schemaVersion, disposition: section.disposition, ledger: section.ledger, bytes };
}

const OWNER_NAMES = new Set<OwnerName>(['diamond', 'taproot', 'workshop']);

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '../src/canonical.js';
import { inspectProtectedCredential } from '../src/secrets.js';
import type { BlobDescriptor, InstallationPorts, OwnerPort, OwnerSection, WorkshopOwnerPort } from '../src/owner-ports.js';
import { OWNER_LEDGER_NAMESPACES, type OwnerDiagnostic, type OwnerName, type SeedbedConfig } from '../src/types.js';

const hashes = {
  diamond: 'a'.repeat(64),
  taproot: 'b'.repeat(64),
  workshop: 'c'.repeat(64),
};

export function fixtureConfig(root: string): SeedbedConfig {
  return {
    formatVersion: 1,
    installationId: 'installation-test',
    baseIri: 'https://test.invalid/installation/',
    packages: {
      diamond: { version: '0.5.0-candidate.1', artifact: 'artifacts/diamond.tgz', sha256: hashes.diamond, sourceCommit: 'a'.repeat(40) },
      taproot: { version: '0.5.0-candidate.1', artifact: 'artifacts/taproot.tgz', sha256: hashes.taproot, sourceCommit: 'b'.repeat(40) },
      workshop: { version: '0.5.0-candidate.1', artifact: 'artifacts/workshop.tgz', sha256: hashes.workshop, sourceCommit: 'c'.repeat(40) },
    },
    compose: {
      projectName: 'gnolith-test',
      workshopPort: 4317,
      publishIpv6Loopback: false,
      profiles: [],
      networkName: 'gnolith',
      dataVolume: 'application-data',
      nodeImage: `node@sha256:${'d'.repeat(64)}`,
    },
    paths: {
      stateDirectory: join(root, 'state'),
      dataDirectory: join(root, 'data'),
      backupDirectory: join(root, 'state', 'backups'),
    },
    authentication: {
      mode: 'local-bearer-v1',
      credentialId: 'local-owner',
      tokenFile: join(root, 'state', 'secrets', 'bearer'),
    },
    endpoints: {},
    migrations: {
      diamond: 'diamond-v1',
      taproot: 'taproot-v1',
      workshop: 'workshop-v1',
      expectedCatalogDigest: 'e'.repeat(64),
    },
    backup: { maxArchiveBytes: 64 * 1024 * 1024, maxBlobBytes: 32 * 1024 * 1024, retain: 7 },
  };
}

export async function createArtifacts(config: SeedbedConfig): Promise<void> {
  await mkdir(config.paths.stateDirectory, { recursive: true });
  for (const owner of ['diamond', 'taproot', 'workshop'] as const) {
    await mkdir(join(process.cwd(), 'artifacts'), { recursive: true });
    await writeFile(join(process.cwd(), config.packages[owner].artifact), owner);
  }
}

class MockOwner implements OwnerPort {
  readonly calls: string[] = [];
  constructor(readonly owner: OwnerName) {}
  async planMigration(expectedVersion: string) {
    this.calls.push('plan');
    return { current: null, target: expectedVersion, digest: this.digest };
  }
  async applyMigration(expectedVersion: string, _operationId: string) {
    this.calls.push('migrate');
    return this.diagnostic(expectedVersion);
  }
  async diagnose() {
    this.calls.push('diagnose');
    return this.diagnostic(`${this.owner}-v1`);
  }
  async inspectBackup() {
    this.calls.push('inspect-backup');
    return { schemaVersion: `${this.owner}-v1`, disposition: 'retained' as const, ledger: this.ledger };
  }
  async exportBackup() {
    this.calls.push('export-backup');
    return this.section;
  }
  async validateBackup(section: OwnerSection) {
    this.calls.push('validate-backup');
    if (section.owner !== this.owner) throw new Error('wrong owner');
    return {};
  }
  async importBackup(_section: OwnerSection, staging: string) {
    this.calls.push('import-backup');
    if (this.owner === 'workshop') await writeFile(join(staging, 'gnolith.sqlite'), 'database');
  }
  get digest() { return sha256(`${this.owner}-migration`); }
  get ledger() { return { namespace: OWNER_LEDGER_NAMESPACES[this.owner], schemaVersion: `${this.owner}-v1`, digest: sha256(`${this.owner}-ledger`) }; }
  get section(): OwnerSection {
    return { owner: this.owner, schemaVersion: `${this.owner}-v1`, disposition: 'retained', ledger: this.ledger, bytes: Buffer.from(`${this.owner}-opaque`) };
  }
  private diagnostic(schemaVersion: string): OwnerDiagnostic {
    return { owner: this.owner, packageVersion: '0.5.0-candidate.1', schemaVersion, migrationDigest: this.digest, ready: true, ledger: this.ledger };
  }
}

class MockWorkshop extends MockOwner implements WorkshopOwnerPort {
  readonly owner = 'workshop' as const;
  constructor(private readonly catalogDigest: string, private readonly order?: string[]) { super('workshop'); }
  async bootstrapV1(input: Parameters<WorkshopOwnerPort['bootstrapV1']>[0]) {
    this.calls.push('bootstrap-v1');
    this.order?.push('bootstrap');
    const { credentialDigest } = await inspectProtectedCredential(input.tokenFile);
    return {
      installationId: input.installationId,
      baseIri: input.baseIri,
      catalogDigest: this.catalogDigest,
      credentialId: `credential:${credentialDigest.slice(0, 32)}`,
      credentialDigest,
    };
  }
}

export function mockPorts(config: SeedbedConfig, blob = Buffer.from('blob-payload')): InstallationPorts & { diamond: MockOwner; taproot: MockOwner; workshop: MockWorkshop } {
  const descriptor: BlobDescriptor = {
    id: 'blob-1',
    bytes: blob.byteLength,
    sha256: sha256(blob),
    ownerDescriptor: Buffer.from('opaque-owner-descriptor-v1'),
  };
  return {
    diamond: new MockOwner('diamond'),
    taproot: new MockOwner('taproot'),
    workshop: new MockWorkshop(config.migrations.expectedCatalogDigest),
    blobs: {
      async *enumerate() { yield descriptor; },
      async open() { async function* stream() { yield blob; } return stream(); },
      async stage(_descriptor, source, staging) {
        await mkdir(staging, { recursive: true });
        for await (const chunk of source) await writeFile(join(staging, 'blob'), chunk);
      },
      async collisionCheck() {},
      async rebind() {},
      async commit() {},
      async rollback() {},
    },
  };
}

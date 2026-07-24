import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyLegacyAdoption, planLegacyAdoption, validateLegacyManifest, type AdoptionCounts, type LegacyDecodedExport } from '../src/adoption.js';
import { fixtureConfig, mockPorts } from './helpers.js';
import { sha256 } from '../src/canonical.js';

const counts: AdoptionCounts = { items: 1, properties: 1, statements: 1, resources: 1, annotations: 1, tasks: 1, memories: 1, prompts: 1, revisions: 8, payloads: 1 };

describe('legacy-local-v1 offline adoption', () => {
  it('accepts only the exact 0.3.2 tuple and commits database last after count/digest/identity verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-adopt-'));
    const database = join(root, 'legacy.sqlite');
    const blobs = join(root, 'legacy-blobs');
    await writeFile(database, 'opaque legacy database');
    await mkdir(blobs);
    const config = fixtureConfig(root);
    const manifest = validateLegacyManifest({
      format: 'gnolith-legacy-local-adoption-v1',
      source: { kind: 'database-and-blobs', databasePath: database, blobPath: blobs },
      expectedInstallationId: config.installationId,
      expectedBaseIri: config.baseIri,
      expectedPackages: { diamond: '0.4.1', taproot: '0.4.2', workshop: '0.4.2', seedbed: '0.3.2' },
      targetComposeProject: config.compose.projectName,
    });
    const ports = mockPorts(config);
    const payload = Buffer.from('blob');
    const exported: LegacyDecodedExport = {
      installationId: config.installationId,
      baseIri: config.baseIri,
      packages: { diamond: '0.4.1', taproot: '0.4.2', workshop: '0.4.2', seedbed: '0.3.2' },
      sections: [ports.diamond.section, ports.taproot.section, ports.workshop.section],
      counts,
      payloadDigests: [{ id: 'blob-1', bytes: payload.byteLength, sha256: sha256(payload) }],
    };
    const decoder = {
      async inspect() { return { ...exported, locked: false }; },
      async export() { return exported; },
      async openPayload() { async function* stream() { yield payload; } return stream(); },
    };
    const events: string[] = [];
    const target = {
      async isEmpty() { return true; },
      async stagingDirectory() { return join(root, 'staging'); },
      async stagePayload() { events.push('payloads'); },
      async collisionCheck() { events.push('collision'); },
      async rebindPayloads() { events.push('rebind'); },
      async commitPayloads() { events.push('commit'); },
      async rollbackPayloads() { events.push('rollback'); },
      async importOwner(section: { owner: string }) { events.push(section.owner); },
      async verify() {
        events.push('verify');
        return { installationId: config.installationId, baseIri: config.baseIri, catalogDigest: config.migrations.expectedCatalogDigest, counts, payloadDigests: exported.payloadDigests };
      },
      async exposeDatabaseLast() { events.push('database-last'); },
      async cleanup() { events.push('cleanup'); },
    };
    const plan = await planLegacyAdoption({ manifest, config, decoder });
    await applyLegacyAdoption({ manifest, plan, config, decoder, target });
    expect(events).toEqual(['payloads', 'collision', 'rebind', 'diamond', 'taproot', 'workshop', 'verify', 'commit', 'database-last']);
    expect(await readFile(database, 'utf8')).toBe('opaque legacy database');
  });

  it('fails closed for incompatible tuples, locked sources, stale plans, loss, and nonempty targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-adopt-fail-'));
    const config = fixtureConfig(root);
    expect(() => validateLegacyManifest({
      format: 'gnolith-legacy-local-adoption-v1',
      source: { kind: 'seedbed-snapshot', snapshotPath: join(root, 'snapshot') },
      expectedInstallationId: config.installationId,
      expectedBaseIri: config.baseIri,
      expectedPackages: { diamond: '0.4.1', taproot: '0.4.2', workshop: '0.4.1', seedbed: '0.3.2' },
      targetComposeProject: config.compose.projectName,
    })).toThrow(/tuple/u);

    const database = join(root, 'legacy.sqlite');
    const blobs = join(root, 'legacy-blobs');
    await writeFile(database, 'unchanged source');
    await mkdir(blobs);
    const manifest = validateLegacyManifest({
      format: 'gnolith-legacy-local-adoption-v1',
      source: { kind: 'database-and-blobs', databasePath: database, blobPath: blobs },
      expectedInstallationId: config.installationId,
      expectedBaseIri: config.baseIri,
      expectedPackages: { diamond: '0.4.1', taproot: '0.4.2', workshop: '0.4.2', seedbed: '0.3.2' },
      targetComposeProject: config.compose.projectName,
    });
    const ports = mockPorts(config);
    const payload = Buffer.from('blob');
    const exported: LegacyDecodedExport = {
      installationId: config.installationId,
      baseIri: config.baseIri,
      packages: { diamond: '0.4.1', taproot: '0.4.2', workshop: '0.4.2', seedbed: '0.3.2' },
      sections: [ports.diamond.section, ports.taproot.section, ports.workshop.section],
      counts,
      payloadDigests: [{ id: 'blob-1', bytes: payload.byteLength, sha256: sha256(payload) }],
    };
    let locked = true;
    const decoder = {
      async inspect() { return { ...exported, locked }; },
      async export() { return exported; },
      async openPayload() { async function* stream() { yield payload; } return stream(); },
    };
    await expect(planLegacyAdoption({ manifest, config, decoder })).rejects.toThrow(/locked/u);
    locked = false;
    const plan = await planLegacyAdoption({ manifest, config, decoder });
    const events: string[] = [];
    const target = {
      async isEmpty() { return false; },
      async stagingDirectory() { return join(root, 'staging'); },
      async stagePayload() { events.push('payloads'); },
      async collisionCheck() {},
      async rebindPayloads() {},
      async commitPayloads() {},
      async rollbackPayloads() { events.push('rollback'); },
      async importOwner() {},
      async verify() { return { installationId: config.installationId, baseIri: config.baseIri, catalogDigest: config.migrations.expectedCatalogDigest, counts, payloadDigests: exported.payloadDigests }; },
      async exposeDatabaseLast() { events.push('database-last'); },
      async cleanup() { events.push('cleanup'); },
    };
    await expect(applyLegacyAdoption({ manifest, plan, config, decoder, target })).rejects.toThrow(/empty/u);
    target.isEmpty = async () => true;
    target.verify = async () => ({
      installationId: config.installationId,
      baseIri: config.baseIri,
      catalogDigest: config.migrations.expectedCatalogDigest,
      counts: { ...counts, items: 0 },
      payloadDigests: exported.payloadDigests,
    });
    await expect(applyLegacyAdoption({ manifest, plan, config, decoder, target })).rejects.toThrow(/loss/u);
    expect(events).toContain('rollback');
    expect(events).toContain('cleanup');
    expect(events).not.toContain('database-last');
    expect(await readFile(database, 'utf8')).toBe('unchanged source');
  });
});

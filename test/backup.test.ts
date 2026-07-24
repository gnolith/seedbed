import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInstallationBackup, dryRunRestore, inspectInstallationBackup, restoreInstallationBackup } from '../src/backup.js';
import { LocalRestoreTarget } from '../src/system-drivers.js';
import { fixtureConfig, mockPorts } from './helpers.js';

describe('opaque owner backup and DB-last restore', () => {
  it('creates a checksummed secret-free envelope with namespace ledger evidence and explicit retention report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-backup-'));
    const config = fixtureConfig(root);
    const ports = mockPorts(config);
    const archive = join(root, 'backup.json');
    const inspection = await createInstallationBackup({ config, ports, destination: archive, now: () => new Date('2026-07-23T00:00:00.000Z') });
    expect(inspection.valid).toBe(true);
    expect(inspection.manifest.sections.map((entry) => entry.owner)).toEqual(['diamond', 'taproot', 'workshop']);
    expect(inspection.retention.retained.join(' ')).toContain('Items');
    expect(inspection.retention.rebuildable.join(' ')).toContain('embeddings');
    expect(inspection.retention.expired).toContain('live task leases');
    expect(await readFile(archive, 'utf8')).not.toMatch(/(?:token|password|api[_-]?key)/iu);
    expect((await dryRunRestore(archive, config, ports)).retention.unsupported).toEqual([]);
  });

  it('rejects tamper, nonempty targets, and cleans interrupted staging before database exposure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-restore-'));
    const sourceConfig = fixtureConfig(join(root, 'source'));
    const archive = join(root, 'backup.json');
    const ports = mockPorts(sourceConfig);
    await createInstallationBackup({ config: sourceConfig, ports, destination: archive });
    const targetConfig = { ...sourceConfig, paths: { ...sourceConfig.paths, dataDirectory: join(root, 'target-data'), stateDirectory: join(root, 'target-state') } };
    const target = new LocalRestoreTarget(targetConfig);
    await expect(restoreInstallationBackup({ path: archive, config: targetConfig, ports, target, interruptAfter: 'taproot' })).rejects.toThrow(/interruption/u);
    await expect(access(join(targetConfig.paths.dataDirectory, 'gnolith.sqlite'))).rejects.toBeTruthy();
    await restoreInstallationBackup({ path: archive, config: targetConfig, ports, target });
    expect(await readFile(join(targetConfig.paths.dataDirectory, 'gnolith.sqlite'), 'utf8')).toBe('database');
    await expect(restoreInstallationBackup({ path: archive, config: targetConfig, ports, target })).rejects.toThrow(/empty/u);

    const tampered = JSON.parse(await readFile(archive, 'utf8')) as { sections: Array<{ base64: string }> };
    tampered.sections[0]!.base64 = Buffer.from('diamond-corrupt').toString('base64');
    await writeFile(join(root, 'tampered.json'), JSON.stringify(tampered));
    await expect(inspectInstallationBackup(join(root, 'tampered.json'), sourceConfig)).rejects.toThrow();
  });
});

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInstallationBackup, inspectInstallationBackup } from '../src/backup.js';
import { canonicalJson } from '../src/canonical.js';
import { fixtureConfig, mockPorts } from './helpers.js';

describe('backup adversarial bounds', () => {
  it('rejects duplicate owners, noncanonical base64, bombs, and existing destinations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-backup-hostile-'));
    const config = fixtureConfig(root);
    const archive = join(root, 'backup.json');
    await createInstallationBackup({ config, ports: mockPorts(config), destination: archive });
    await expect(createInstallationBackup({ config, ports: mockPorts(config), destination: archive })).rejects.toBeTruthy();

    const duplicate = JSON.parse(await readFile(archive, 'utf8')) as { sections: Array<{ owner: string }> };
    duplicate.sections[1]!.owner = 'diamond';
    await writeFile(join(root, 'duplicate.json'), `${canonicalJson(duplicate)}\n`);
    await expect(inspectInstallationBackup(join(root, 'duplicate.json'), config)).rejects.toThrow(/duplicated/u);

    const invalid = JSON.parse(await readFile(archive, 'utf8')) as { sections: Array<{ base64: string }> };
    invalid.sections[0]!.base64 = '!!!!';
    await writeFile(join(root, 'invalid.json'), `${canonicalJson(invalid)}\n`);
    await expect(inspectInstallationBackup(join(root, 'invalid.json'), config)).rejects.toThrow(/base64/u);

    const bombConfig = { ...config, backup: { ...config.backup, maxArchiveBytes: 64 } };
    await expect(inspectInstallationBackup(archive, bombConfig)).rejects.toThrow(/bounded/u);
  });
});

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { loadConfig, requireBaseIri } from '../src/config.js';

describe('configuration', () => {
  it('applies CLI > environment > file > defaults', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'seedbed-config-'));
    await writeFile(join(cwd, 'seedbed.config.json'), JSON.stringify({
      databasePath: './from-file.sqlite',
      baseIri: 'https://file.example/',
      principalSelector: 'file-owner',
      logLevel: 'warn',
      shutdownTimeoutMs: 500,
    }));
    const config = await loadConfig(
      { databasePath: './from-cli.sqlite', principalSelector: 'cli-owner' },
      { SEEDBED_DATABASE_PATH: './from-env.sqlite', SEEDBED_BASE_IRI: 'https://env.example/' },
      cwd,
    );
    expect(config.databasePath).toBe(join(cwd, 'from-cli.sqlite'));
    expect(config.blobPath).toBe(join(cwd, '.seedbed', 'blobs'));
    expect(config.busyTimeoutMs).toBe(5_000);
    expect(config.baseIri).toBe('https://env.example');
    expect(config.principalSelector).toBe('cli-owner');
    expect(config.logLevel).toBe('warn');
    expect(config.shutdownTimeoutMs).toBe(500);
  });

  it('resolves the default database inside cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'seedbed-default-'));
    await mkdir(cwd, { recursive: true });
    const config = await loadConfig({}, {}, cwd);
    expect(config.databasePath).toBe(join(cwd, '.seedbed', 'gnolith.sqlite'));
    expect(config.blobPath).toBe(join(cwd, '.seedbed', 'blobs'));
  });

  it.each(['relative', 'ftp://example.com/x', 'https://u:p@example.com/x', 'https://example.com/x?query=1', 'https://example.com/x#fragment'])(
    'rejects invalid base IRI %s',
    async (baseIri) => {
      await expect(loadConfig({ baseIri }, {}, process.cwd())).rejects.toMatchObject({ code: 'invalid_base_iri' });
    },
  );

  it('rejects a query-bearing base IRI before a database can be created', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'seedbed-invalid-iri-'));
    const databasePath = join(cwd, 'must-not-exist.sqlite');
    await expect(loadConfig({
      databasePath,
      baseIri: 'https://example.test/instance?tenant=other',
    }, {}, cwd)).rejects.toMatchObject({ code: 'invalid_base_iri' });
    await expect(stat(databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires base IRI when persistence identity is needed', async () => {
    const config = await loadConfig({}, {}, process.cwd());
    expect(() => requireBaseIri(config)).toThrow(/stable absolute HTTP\(S\) base IRI/u);
  });

  it('rejects simultaneous root-secret selectors', async () => {
    await expect(loadConfig({ rootSecretFile: './secret', rootSecretFd: 3 }, {}, process.cwd())).rejects.toMatchObject({ code: 'invalid_root_secret' });
  });

  it.each([-1, 300_001, 1.5, 'not-a-number'])(
    'rejects invalid SQLite busy timeout %s',
    async (busyTimeoutMs) => {
      await expect(loadConfig({ busyTimeoutMs }, {}, process.cwd())).rejects.toMatchObject({ code: 'invalid_config' });
    },
  );
});

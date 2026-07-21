import { mkdir, writeFile } from 'node:fs/promises';
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
      localOwnerId: 'file-owner',
      logLevel: 'warn',
      shutdownTimeoutMs: 500,
    }));
    const config = await loadConfig(
      { databasePath: './from-cli.sqlite', localOwnerId: 'cli-owner' },
      { SEEDBED_DATABASE_PATH: './from-env.sqlite', SEEDBED_BASE_IRI: 'https://env.example/' },
      cwd,
    );
    expect(config.databasePath).toBe(join(cwd, 'from-cli.sqlite'));
    expect(config.baseIri).toBe('https://env.example/');
    expect(config.localOwnerId).toBe('cli-owner');
    expect(config.logLevel).toBe('warn');
    expect(config.shutdownTimeoutMs).toBe(500);
  });

  it('resolves the default database inside cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'seedbed-default-'));
    await mkdir(cwd, { recursive: true });
    const config = await loadConfig({}, {}, cwd);
    expect(config.databasePath).toBe(join(cwd, '.seedbed', 'gnolith.sqlite'));
  });

  it.each(['relative', 'ftp://example.com/x', 'https://u:p@example.com/x', 'https://example.com/x#fragment'])(
    'rejects invalid base IRI %s',
    async (baseIri) => {
      await expect(loadConfig({ baseIri }, {}, process.cwd())).rejects.toMatchObject({ code: 'invalid_base_iri' });
    },
  );

  it('requires base IRI when persistence identity is needed', async () => {
    const config = await loadConfig({}, {}, process.cwd());
    expect(() => requireBaseIri(config)).toThrow(/stable absolute HTTP\(S\) base IRI/u);
  });
});


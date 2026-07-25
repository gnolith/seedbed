import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { canonicalJson } from '../src/canonical.js';
import { fixtureConfig } from './helpers.js';

describe('canonical config generation', () => {
  it('writes an exact validated config exclusively without creating a credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-init-'));
    const template = join(root, 'template.json');
    const output = join(root, 'seedbed.config.json');
    const config = fixtureConfig(root);
    await writeFile(template, JSON.stringify(config, null, 2));
    let stdout = '';
    let stderr = '';
    const original = process.stdout.write;
    const originalError = process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { stdout += chunk.toString(); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { stderr += chunk.toString(); return true; }) as typeof process.stderr.write;
    try {
      expect(await runCli(['init', '--config', output, '--from', template])).toBe(0);
      expect(await runCli(['init', '--config', output, '--from', template])).toBe(2);
      expect(await runCli(['doctor', '--config', output, '--dry-run'])).toBe(2);
      expect(await runCli(['plan', '--config', output, '--unexpected', output])).toBe(2);
    } finally {
      process.stdout.write = original;
      process.stderr.write = originalError;
    }
    expect(await readFile(output, 'utf8')).toBe(`${canonicalJson(config)}\n`);
    expect(stdout).toContain('"secretCreated":false');
    await expect(readFile(config.authentication.tokenFile)).rejects.toBeTruthy();
    expect(stderr).toContain('seedbed_operation_failed');
    expect(stderr).toContain('Unsupported --dry-run for doctor');
    expect(stderr).toContain('Unsupported --unexpected for plan');
  });
});

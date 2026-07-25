import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

describe('breaking public surface', () => {
  it('exposes only installation/operator commands', async () => {
    let output = '';
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write;
    try {
      expect(await runCli(['--help'])).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    for (const command of ['init', 'plan', 'apply', 'migrate plan', 'migrate apply', 'doctor', 'backup create', 'backup restore', 'adopt legacy-local plan', 'uninstall']) expect(output).toContain(command);
    expect(output).not.toMatch(/\b(?:mcp|stdio|tools|call|serve|search|semantic|snapshot)\b/u);
  });

  it('has no runtime dependencies or removed application modules and packs Compose plumbing', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { dependencies?: unknown; files: string[]; version: string };
    expect(packageJson.version).toBe('0.4.0');
    expect(packageJson.dependencies).toBeUndefined();
    expect(packageJson.files).toContain('compose');
    expect(packageJson.files).toContain('docker');
    for (const path of ['src/mcp.ts', 'src/runtime.ts', 'src/authorization.ts', 'src/snapshot.ts', 'src/taproot-runtime.ts', 'Dockerfile']) {
      await expect(readFile(path)).rejects.toBeTruthy();
    }
  });
});

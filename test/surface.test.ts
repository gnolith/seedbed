import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('headless product boundary', () => {
  it('advertises only the approved process commands', async () => {
    const source = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
    for (const command of ['init', 'migrate', 'doctor', 'mcp', 'tools', 'call', 'sparql']) {
      expect(source).toContain(`case '${command}'`);
    }
    expect(source).not.toMatch(/case ['"](?:serve|http|ui)['"]/u);
  });

  it('contains no listening socket implementation', async () => {
    const files = ['cli.ts', 'runtime.ts', 'mcp.ts'];
    for (const file of files) {
      const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/\.listen\s*\(|createServer\s*\(/u);
    }
  });
});


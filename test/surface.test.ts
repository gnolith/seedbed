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

  it('installs only the content-addressed production closure without registry access', async () => {
    const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toContain('ARG PRODUCTION_CLOSURE_SHA256');
    expect(dockerfile).toContain('RUN --network=none');
    expect(dockerfile).toContain('sha256sum --check');
    expect(dockerfile).toContain('production-package-lock.json');
    expect(dockerfile).toContain('verify-production-tree.mjs --archive');
    expect(dockerfile).toContain('verify-production-tree.mjs --verify');
    expect(dockerfile).not.toMatch(/\bnpm (?:ci|install|pack)\b/u);
    expect(dockerfile).not.toContain('registry.npmjs.org');
  });

  it('pins a complete integrity-addressed production dependency graph', async () => {
    const lock = JSON.parse(await readFile(new URL('../docker/package-lock.json', import.meta.url), 'utf8')) as {
      packages: Record<string, { integrity?: string; link?: boolean; resolved?: string }>;
    };
    const entries = Object.entries(lock.packages).filter(([location, value]) => location && !value.link);
    expect(entries.length).toBeGreaterThan(0);
    for (const [location, value] of entries) {
      expect(value.integrity, location).toMatch(/^sha512-/u);
      expect(value.resolved, location).toMatch(/^https:\/\/registry\.npmjs\.org\//u);
    }
  });

  it('proves the staged cache can realize the lock offline and binds exact artifacts', async () => {
    const script = await readFile(new URL('../scripts/build-production-closure.sh', import.meta.url), 'utf8');
    expect(script).toContain('npm ci --offline --registry=http://127.0.0.1:9');
    expect(script).toContain('artifact_integrity');
    expect(script).toContain('locked_integrity');
    expect(script).toContain('Seedbed artifact integrity does not match the verified publication artifact');
    expect(script).toContain('docker/package-lock.json');
    expect(script).toContain('verify-production-tree.mjs" --write');
    for (const rejection of ['an extra file', 'a changed executable mode', 'a changed symlink target', 'an unsafe archive path']) {
      expect(script).toContain(rejection);
    }
  });
});


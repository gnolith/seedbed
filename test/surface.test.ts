import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('headless product boundary', () => {
  it('advertises only the approved process commands', async () => {
    const source = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
    for (const command of ['init', 'migrate', 'doctor', 'auth', 'mcp', 'tools', 'call']) {
      expect(source).toContain(`case '${command}'`);
    }
    expect(source).not.toMatch(/case ['"](?:serve|http|ui)['"]/u);
    expect(source).not.toMatch(/case ['"]sparql['"]/u);
  });

  it('contains no listening socket implementation', async () => {
    const files = ['cli.ts', 'runtime.ts', 'mcp.ts'];
    for (const file of files) {
      const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/\.listen\s*\(|createServer\s*\(/u);
    }
  });

  it('keeps authorization administration on the host CLI and out of MCP', async () => {
    const cli = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const mcp = await readFile(new URL('../src/mcp.ts', import.meta.url), 'utf8');
    expect(cli).toContain('auth apply --manifest <path>');
    expect(cli).toContain('replacePrincipalAuthorization');
    expect(mcp).not.toContain('replacePrincipalAuthorization');
    expect(mcp).not.toContain('auth apply');
  });

  it('keeps raw SPARQL and raw secret material out of every process test surface', async () => {
    for (const file of ['packed-system-test.mjs', 'published-system-test.mjs', 'docker-smoke.mjs']) {
      const source = await readFile(new URL(`../scripts/${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/['"]sparql['"]/u);
      expect(source).not.toContain('SEEDBED_LOCAL_OWNER_ID');
      expect(source).not.toContain('SEEDBED_ROOT_SECRET=');
    }
    const docker = await readFile(new URL('../scripts/docker-smoke.mjs', import.meta.url), 'utf8');
    expect(docker).toContain('-m 0400 /input /secret/seedbed-root');
    expect(docker).toContain("'/proc/net/tcp'");
    expect(docker).toContain("fields[3] === '0A'");
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

  it('ships only the tree-shaken stdio MCP runtime and fails closed on audit drift', async () => {
    for (const path of ['../package.json', '../docker/package.json']) {
      const manifest = JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        overrides?: Record<string, string>;
      };
      expect(manifest.dependencies).not.toHaveProperty('@modelcontextprotocol/sdk');
      expect(manifest.dependencies).not.toHaveProperty('@hono/node-server');
      if (path === '../package.json') {
        expect(manifest.devDependencies?.['@modelcontextprotocol/sdk']).toBe('1.29.0');
        expect(manifest.overrides?.['@hono/node-server']).toBe('2.0.11');
      } else {
        expect(manifest.overrides).toBeUndefined();
      }
    }
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.check).toContain('npm run security:runtime-check');
    expect(manifest.scripts['security:runtime-check']).toBe('node scripts/audit-zero.mjs --full && node scripts/audit-zero.mjs');
    const audit = await readFile(new URL('../scripts/audit-zero.mjs', import.meta.url), 'utf8');
    expect(audit).toContain("result.status !== 0 || total !== 0");
    expect(audit).toContain("'--omit=dev', '--json'");
    const bundleVerifier = await readFile(new URL('../scripts/bundled-runtime-inventory.mjs', import.meta.url), 'utf8');
    expect(bundleVerifier).toContain("if (/hono|StreamableHTTP|serve-static/iu.test(code))");
    const sbom = JSON.parse(await readFile(new URL('../docs/mcp-runtime-sbom.json', import.meta.url), 'utf8')) as {
      packageCount: number;
      packages: Array<{ integrity: string; license: string; name: string; version: string }>;
    };
    expect(sbom.packageCount).toBe(8);
    expect(sbom.packages).toContainEqual(expect.objectContaining({ name: '@modelcontextprotocol/sdk', version: '1.29.0' }));
    expect(sbom.packages.some(({ name }) => name.toLowerCase().includes('hono'))).toBe(false);
    for (const component of sbom.packages) {
      expect(component.integrity, component.name).toMatch(/^sha512-/u);
      expect(component.license, component.name).not.toBe('');
    }
    const packed = await readFile(new URL('../scripts/packed-system-test.mjs', import.meta.url), 'utf8');
    expect(packed).toContain("runNpm(['audit', '--omit=dev', '--json'], fixture)");
    expect(packed).toContain('auditReport.metadata?.vulnerabilities?.total !== 0');
    expect(packed).toContain("'ci', '--ignore-scripts', '--offline'");
    expect(packed).toContain('http://127.0.0.1:9');
  });

  it('proves the staged cache can realize the lock offline and binds exact artifacts', async () => {
    const script = await readFile(new URL('../scripts/build-production-closure.sh', import.meta.url), 'utf8');
    expect(script).toContain('npm ci --offline --registry=http://127.0.0.1:9');
    expect(script).toContain('artifact_integrity');
    expect(script).toContain('locked_integrity');
    expect(script).toContain('Seedbed artifact integrity does not match the verified publication artifact');
    expect(script).toContain('report.metadata?.vulnerabilities?.total');
    expect(script).toContain("status !== '0' || total !== 0");
    expect(script).toContain('docker/package-lock.json');
    expect(script).toContain('verify-production-tree.mjs" --write');
    for (const rejection of ['an extra file', 'a changed executable mode', 'a changed symlink target', 'an unsafe archive path']) {
      expect(script).toContain(rejection);
    }
  });
});


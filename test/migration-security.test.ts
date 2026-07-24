import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyInstallationPlan, createInstallationPlan } from '../src/migration.js';
import { createLocalBearerCredential, decodeCanonicalTextSecret, inspectProtectedCredential } from '../src/secrets.js';
import { fixtureConfig, mockPorts } from './helpers.js';
import { acquireOperationLock } from '../src/operation-lock.js';
import { semanticConfigurationFingerprint } from '../src/semantic.js';
import { sha256 } from '../src/canonical.js';

describe('digest-bound migration/bootstrap apply', () => {
  it('orders owner migrations and Workshop-only bootstrap before listener, resumes after interruption, and emits selector-only receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-apply-'));
    const config = fixtureConfig(root);
    const ports = mockPorts(config);
    const order: string[] = [];
    for (const owner of ['diamond', 'taproot', 'workshop'] as const) {
      const original = ports[owner].applyMigration.bind(ports[owner]);
      ports[owner].applyMigration = async (...args) => { order.push(owner); return original(...args); };
    }
    const originalBootstrap = ports.workshop.bootstrapV1.bind(ports.workshop);
    ports.workshop.bootstrapV1 = async (input) => { order.push('bootstrap'); return originalBootstrap(input); };
    const compose = {
      async prepare() { order.push('prepare'); },
      async up() { order.push('up'); },
      async health() { return { healthy: true }; },
      async downRetainData() {},
    };
    const plan = createInstallationPlan(config);
    await expect(applyInstallationPlan({ config, plan, ports, compose, interruptAfter: 'taproot-migrate' })).rejects.toThrow(/interruption/u);
    const receipt = await applyInstallationPlan({ config, plan, ports, compose });
    expect(order.filter((entry) => ['diamond', 'taproot', 'workshop'].includes(entry))).toEqual(['diamond', 'taproot', 'workshop']);
    expect(order.indexOf('bootstrap')).toBeLessThan(order.indexOf('up'));
    expect(receipt.requiredEnvironmentSelector).toBe('GNOLITH_BEARER_TOKEN');
    expect(receipt.clientVerified).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain((await readFile(config.authentication.tokenFile, 'utf8')).trim());
    expect(await stat(config.authentication.tokenFile)).toMatchObject({ size: 43 });
  });

  it('creates exactly 32 CSPRNG bytes as canonical base64url and refuses existing files and link parents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-secret-'));
    const path = join(root, 'state', 'bearer');
    const metadata = await createLocalBearerCredential('credential', path, {
      platform: process.platform,
      random: () => Buffer.alloc(32, 0xab),
      windowsAcl: () => undefined,
    });
    const content = await readFile(path, 'utf8');
    expect(content).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(metadata).not.toHaveProperty('token');
    await expect(createLocalBearerCredential('credential', path, { platform: process.platform, windowsAcl: () => undefined })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path, 'utf8')).toBe(content);
    await mkdir(join(root, 'real'));
    if (process.platform !== 'win32') {
      await symlink(join(root, 'real'), join(root, 'linked'));
      await expect(createLocalBearerCredential('credential', join(root, 'linked', 'bearer'))).rejects.toThrow(/link|junction/u);
    }
  });

  it('normalizes at most one terminal LF or CRLF and rejects every other surrounding or control byte', async () => {
    expect(decodeCanonicalTextSecret('packed_exact_local_token')).toBe('packed_exact_local_token');
    expect(decodeCanonicalTextSecret('packed_exact_local_token\n')).toBe('packed_exact_local_token');
    expect(decodeCanonicalTextSecret('packed_exact_local_token\r\n')).toBe('packed_exact_local_token');
    for (const invalid of [
      '',
      ' packed_exact_local_token',
      'packed_exact_local_token ',
      'packed_exact_local_token\t',
      'packed_exact_local_token\r',
      'packed_exact_local_token\n\n',
      'packed_exact\u0000local_token',
    ]) expect(() => decodeCanonicalTextSecret(invalid)).toThrow(/protected text secret/i);

    const root = await mkdtemp(join(tmpdir(), 'seedbed-secret-newline-'));
    const token = 'a'.repeat(43);
    for (const [name, suffix] of [['none', ''], ['lf', '\n'], ['crlf', '\r\n']] as const) {
      const path = join(root, name);
      await writeFile(path, `${token}${suffix}`, { mode: 0o600 });
      await expect(inspectProtectedCredential(path, process.platform)).resolves.toEqual({
        credentialDigest: sha256(token),
      });
    }
  });

  it('configures semantics offline after bootstrap and before listener with a selector-free receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-semantic-apply-'));
    const base = fixtureConfig(root);
    const semanticCredential = join(root, 'openai-profile');
    await writeFile(semanticCredential, 'protected-openai-profile');
    const config = {
      ...base,
      semantic: {
        configuration: {
          version: 1 as const,
          id: 'semantic',
          name: 'Semantic',
          provider: {
            kind: 'openai-compatible' as const,
            endpoint: 'https://api.openai.com/v1/embeddings',
            model: 'text-embedding-3-small',
            dimensions: 1536,
            metric: 'cosine' as const,
            credentialSelector: 'openai-profile',
            allowPrivateEndpoint: false,
            redirectPolicy: 'error' as const,
          },
          vector: { kind: 'sqlite' as const },
        },
        expectedRevision: 0,
        credentialSelectors: [{
          id: 'openai-profile',
          kind: 'protected-file-v1' as const,
          path: semanticCredential,
        }],
      },
    };
    const ports = mockPorts(config);
    const order: string[] = [];
    const bootstrap = ports.workshop.bootstrapV1.bind(ports.workshop);
    ports.workshop.bootstrapV1 = async (input) => { order.push('bootstrap'); return bootstrap(input); };
    const configure = ports.workshop.configureSemanticV1.bind(ports.workshop);
    let configuredEndpoint: string | undefined;
    ports.workshop.configureSemanticV1 = async (input) => {
      order.push('semantic');
      configuredEndpoint = input.configuration.provider.endpoint;
      return configure(input);
    };
    const compose = {
      async prepare() {},
      async up() { order.push('up'); },
      async health() { return { healthy: true }; },
      async downRetainData() {},
    };
    const receipt = await applyInstallationPlan({ config, plan: createInstallationPlan(config), ports, compose });
    expect(order).toEqual(['bootstrap', 'semantic', 'up']);
    expect(configuredEndpoint).toBe('https://api.openai.com/v1/embeddings');
    expect(receipt.semantic).toEqual({
      fingerprint: semanticConfigurationFingerprint(config.semantic.configuration),
      revision: 1,
      state: 'unvalidated',
    });
    expect(receipt.semantic?.fingerprint).toBe('3dd271b18d3b2448b51be87af7b8e49ac7046c872d122135f32e859b2d9b33d1');
    expect(JSON.stringify(receipt)).not.toContain('api.openai.com');
    expect(JSON.stringify(receipt)).not.toContain('text-embedding-3-small');
    expect(JSON.stringify(receipt)).not.toContain('protected-openai-profile');
  });

  it('rejects plan drift without mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-drift-'));
    const config = fixtureConfig(root);
    const ports = mockPorts(config);
    const compose = { async prepare() {}, async up() {}, async health() { return { healthy: true }; }, async downRetainData() {} };
    const plan = createInstallationPlan(config);
    await expect(applyInstallationPlan({ config: { ...config, compose: { ...config.compose, workshopPort: 4318 } }, plan, ports, compose })).rejects.toThrow(/does not match/u);
    expect(ports.diamond.calls).toEqual([]);
  });

  it('serializes all installation mutations and safely recovers a dead-process lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-lock-'));
    const path = join(root, 'installation-operation.lock');
    const first = await acquireOperationLock(path, 'first');
    await expect(acquireOperationLock(path, 'second')).rejects.toThrow(/already active/u);
    await first.release();
    await writeFile(path, JSON.stringify({ format: 'gnolith-seedbed-operation-lock-v1', operationId: 'stale', pid: 2147483647 }));
    const recovered = await acquireOperationLock(path, 'recovered');
    await recovered.release();
  });
});

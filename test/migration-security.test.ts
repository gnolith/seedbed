import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyInstallationPlan, createInstallationPlan } from '../src/migration.js';
import { createLocalBearerCredential } from '../src/secrets.js';
import { fixtureConfig, mockPorts } from './helpers.js';
import { acquireOperationLock } from '../src/operation-lock.js';

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
    expect(await stat(config.authentication.tokenFile)).toMatchObject({ size: 44 });
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
    expect(content).toMatch(/^[A-Za-z0-9_-]{43}\n$/u);
    expect(metadata).not.toHaveProperty('token');
    await expect(createLocalBearerCredential('credential', path, { platform: process.platform, windowsAcl: () => undefined })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path, 'utf8')).toBe(content);
    await mkdir(join(root, 'real'));
    if (process.platform !== 'win32') {
      await symlink(join(root, 'real'), join(root, 'linked'));
      await expect(createLocalBearerCredential('credential', join(root, 'linked', 'bearer'))).rejects.toThrow(/link|junction/u);
    }
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

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createItem } from '@gnolith/taproot';
import { describe, expect, it } from 'vitest';
import { bootstrapAuthorization, openAuthorization } from '../src/authorization.js';
import type { SeedbedConfig } from '../src/config.js';
import { initializeDatabase, openDatabase } from '../src/persistence.js';
import { createSeedbedRuntime } from '../src/runtime.js';
import { loadTaprootAssembly } from '../src/taproot-bridge.js';

interface Baseline {
  fixtureResources: number;
  maximumIngestAndMaterializeMilliseconds: number;
  maximumSearchP95Milliseconds: number;
  maximumDatabaseBytes: number;
}

describe('native performance qualification', () => {
  it('stays within the committed bounded-search baseline', { timeout: 30_000 }, async () => {
    const baseline = JSON.parse(await readFile(new URL('../docs/performance-baseline.json', import.meta.url), 'utf8')) as Baseline;
    const directory = await mkdtemp(join(tmpdir(), 'seedbed-performance-'));
    const secret = join(directory, 'root.key');
    await writeFile(secret, Buffer.alloc(32, 0x70), { mode: 0o600 });
    const config: SeedbedConfig = { databasePath: join(directory, 'gnolith.sqlite'), blobPath: join(directory, 'blobs'), baseIri: 'https://performance.seedbed.test/', rootSecretFile: secret, principalSelector: 'owner', workspaceSelector: 'workspace', logLevel: 'silent', shutdownTimeoutMs: 2_000 };
    const taproot = await loadTaprootAssembly();
    await initializeDatabase(config, taproot);
    const maintenance = await openDatabase(config);
    const owner = await bootstrapAuthorization(maintenance, config, 'owner', 'workspace');
    const authority = await openAuthorization(maintenance, config);
    await createItem(maintenance, { baseIri: config.baseIri! }, authority.authorizationGuard, owner, { id: 'Q1', labels: { en: { language: 'en', value: 'Performance fixture' } }, authorization: { installationId: owner.installationId, workspaceId: owner.activeWorkspaceId, ownerPrincipalId: owner.principalId, visibility: { version: 1, clauses: [] }, statementRestrictions: {}, expectedAuthorizationRevision: owner.authorizationRevision } });
    await maintenance.close();
    const runtime = await createSeedbedRuntime(config, taproot);
    const call = (name: string, args: Record<string, unknown>) => runtime.dispatcher.callTool({ name, arguments: args }, { principal: runtime.principal, requestId: randomUUID() });
    try {
      const started = performance.now();
      for (let index = 0; index < baseline.fixtureResources; index += 1) {
        const text = `basalt performance specimen ${index} with olivine crystals`;
        const bytes = Buffer.from(text);
        const result = await call('content_resource_create', { resource: { id: `performance-${index}`, itemId: 'Q1', title: `Specimen ${index}`, payload: { kind: 'inline-text', text }, mediaType: 'text/plain', language: 'en', integrity: { algorithm: 'sha256', digest: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength } } });
        expect(result.ok).toBe(true);
      }
      expect(performance.now() - started).toBeLessThan(baseline.maximumIngestAndMaterializeMilliseconds);
      const latencies: number[] = [];
      for (let index = 0; index < 10; index += 1) {
        const before = performance.now();
        const result = await call('search', { text: 'olivine', kinds: ['resource'], limit: 25 });
        latencies.push(performance.now() - before);
        expect(result).toMatchObject({ ok: true, value: { results: expect.any(Array) } });
      }
      latencies.sort((left, right) => left - right);
      expect(latencies[Math.ceil(latencies.length * 0.95) - 1]).toBeLessThan(baseline.maximumSearchP95Milliseconds);
      expect((await stat(config.databasePath)).size).toBeLessThan(baseline.maximumDatabaseBytes);
    } finally {
      await runtime.close();
    }
  });
});

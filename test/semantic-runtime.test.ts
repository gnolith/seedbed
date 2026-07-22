import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createItem, TaprootContentRepositoryV1 } from '@gnolith/taproot';
import { describe, expect, it } from 'vitest';
import { bootstrapAuthorization, openAuthorization } from '../src/authorization.js';
import type { SeedbedConfig } from '../src/config.js';
import { initializeDatabase, openDatabase } from '../src/persistence.js';
import { createSeedbedRuntime } from '../src/runtime.js';
import { loadTaprootAssembly } from '../src/taproot-bridge.js';

describe('native semantic executor', () => {
  it('executes an approved SQLite plan headlessly and survives restart', { timeout: 15_000 }, async () => {
    let failingRequests = 0;
    const provider = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        if (request.url?.startsWith('/fail/')) {
          failingRequests += 1;
          response.statusCode = 503;
          response.end('{}');
          return;
        }
        const input = JSON.parse(body).input as string[];
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: input.map(() => ({ embedding: [1, 0] })), usage: { total_tokens: input.length * 3 } }));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('deterministic provider did not bind');
    const directory = await mkdtemp(join(tmpdir(), 'seedbed-semantic-runtime-'));
    const secret = join(directory, 'root.key');
    await writeFile(secret, Buffer.alloc(32, 0x73), { mode: 0o600 });
    const config: SeedbedConfig = {
      databasePath: join(directory, 'gnolith.sqlite'), blobPath: join(directory, 'blobs'), baseIri: 'https://semantic-runtime.seedbed.test/',
      rootSecretFile: secret, principalSelector: 'owner', workspaceSelector: 'workspace', logLevel: 'silent', shutdownTimeoutMs: 2_000,
      semanticConfigurations: [
        { id: 'deterministic', name: 'Deterministic fixture', selected: true, provider: { kind: 'openai-compatible', endpoint: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', dimensions: 2, allowPrivateEndpoint: true }, vectorIndex: { kind: 'sqlite' } },
        { id: 'failing', name: 'Failing fixture', provider: { kind: 'openai-compatible', endpoint: `http://127.0.0.1:${address.port}/fail`, model: 'fixture', dimensions: 2, allowPrivateEndpoint: true }, vectorIndex: { kind: 'sqlite' } },
      ],
    };
    const taproot = await loadTaprootAssembly();
    try {
      await initializeDatabase(config, taproot);
      const db = await openDatabase(config);
      const owner = await bootstrapAuthorization(db, config, 'owner', 'workspace');
      const authority = await openAuthorization(db, config);
      await createItem(db, { baseIri: config.baseIri! }, authority.authorizationGuard, owner, { id: 'Q1', labels: { en: { language: 'en', value: 'Serpentinite sample' } }, authorization: { installationId: owner.installationId, workspaceId: owner.activeWorkspaceId, ownerPrincipalId: owner.principalId, visibility: { version: 1, clauses: [] }, statementRestrictions: {}, expectedAuthorizationRevision: owner.authorizationRevision } });
      const current = await authority.resolveContext('owner', 'workspace');
      const text = 'Magnesium silicate mineral specimen';
      await new TaprootContentRepositoryV1(db, { installationId: owner.installationId }).createResource({ id: 'semantic-resource', itemId: 'Q1', payload: { kind: 'inline-text', text }, mediaType: 'text/plain', integrity: { algorithm: 'sha256', digest: createHash('sha256').update(text).digest('hex'), byteLength: Buffer.byteLength(text) } }, { context: current, attribution: { id: 'owner', kind: 'human' }, workspaceId: 'workspace', ownerPrincipalId: 'owner', visibility: { version: 1, clauses: [] }, expectedAuthorizationRevision: current.authorizationRevision });
      await db.close();

      let runtime = await createSeedbedRuntime(config, taproot);
      const call = (name: string, args: Record<string, unknown>) => runtime.dispatcher.callTool({ name, arguments: args }, { principal: runtime.principal, requestId: randomUUID() });
      const estimate = await call('semantic_estimate', { configurationId: 'deterministic', policy: { mode: 'asap', maxBatchesPerRun: 1 } });
      expect(failingRequests).toBe(3);
      expect(estimate).toMatchObject({ ok: true, value: { planId: expect.any(String) } });
      const planId = (estimate as { ok: true; value: { planId: string } }).value.planId;
      expect(await call('semantic_approve', { planId })).toMatchObject({ ok: true });
      let complete = false;
      for (let attempt = 0; attempt < 30 && !complete; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const status = await call('semantic_status', {});
        complete = status.ok && (status.value as { selectedReady: boolean; plans: Array<{ planId: string; state: string }> }).selectedReady
          && (status.value as { plans: Array<{ planId: string; state: string }> }).plans.some((plan) => plan.planId === planId && plan.state === 'complete');
      }
      expect(complete).toBe(true);
      const semanticOnly = await call('search', { text: 'concept-with-no-lexical-overlap', kinds: ['resource'], limit: 5 });
      expect(semanticOnly).toMatchObject({ ok: true, value: { results: [expect.objectContaining({ sourceId: 'semantic-resource' })] } });
      expect(await call('semantic_select', { configurationId: 'failing' })).toMatchObject({ ok: true });
      await expect(call('search', { text: 'Magnesium', kinds: ['resource'], limit: 5 })).resolves.toMatchObject({ ok: true, value: { results: [expect.objectContaining({ sourceId: 'semantic-resource' })] } });
      expect(failingRequests).toBe(3);
      await expect(call('semantic_reconnect', { configurationId: 'failing' })).resolves.toMatchObject({ ok: true, value: { connected: false } });
      expect(failingRequests).toBe(6);
      expect(await call('semantic_select', { configurationId: 'deterministic' })).toMatchObject({ ok: true });
      await runtime.close();

      runtime = await createSeedbedRuntime(config, taproot);
      try {
        await expect(call('search', { text: 'another-semantic-only-concept', kinds: ['resource'], limit: 5 })).resolves.toMatchObject({ ok: true, value: { results: [expect.objectContaining({ sourceId: 'semantic-resource' })] } });
      } finally {
        await runtime.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    }
  });
});

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createItem } from '@gnolith/taproot';
import type { SeedbedConfig } from '../src/config.js';
import { bootstrapAuthorization, openAuthorization } from '../src/authorization.js';
import { initializeDatabase, openDatabase } from '../src/persistence.js';
import { createSeedbedRuntime } from '../src/runtime.js';
import { loadTaprootAssembly } from '../src/taproot-bridge.js';

describe('Taproot content and authorized search assembly', () => {
  it('materializes and hydrates package-owned Item, Resource, and Annotation kinds', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seedbed-search-'));
    const secret = join(directory, 'root.key');
    await writeFile(secret, Buffer.alloc(32, 0x72), { mode: 0o600 });
    const config: SeedbedConfig = {
      databasePath: join(directory, 'gnolith.sqlite'), blobPath: join(directory, 'blobs'),
      baseIri: 'https://search.seedbed.test/installation/', rootSecretFile: secret,
      principalSelector: 'owner', workspaceSelector: 'workspace', logLevel: 'silent', shutdownTimeoutMs: 1_000,
    };
    const taproot = await loadTaprootAssembly();
    await initializeDatabase(config, taproot);
    const maintenance = await openDatabase(config);
    const owner = await bootstrapAuthorization(maintenance, config, 'owner', 'workspace');
    const authority = await openAuthorization(maintenance, config);
    await createItem(maintenance, { baseIri: config.baseIri! }, authority.authorizationGuard, owner, {
      id: 'Q1', labels: { en: { language: 'en', value: 'Basalt sample' } }, descriptions: { en: { language: 'en', value: 'A volcanic stone' } },
      authorization: { installationId: owner.installationId, workspaceId: owner.activeWorkspaceId, ownerPrincipalId: owner.principalId, visibility: { version: 1, clauses: [] }, statementRestrictions: {}, expectedAuthorizationRevision: owner.authorizationRevision },
    });
    await maintenance.close();
    const runtime = await createSeedbedRuntime(config, taproot);
    const call = (name: string, args: Record<string, unknown>) => runtime.dispatcher.callTool(
      { name, arguments: args }, { principal: runtime.principal, requestId: randomUUID() },
    );
    try {
      const itemId = 'Q1' as const;
      const text = 'Microscopic olivine crystals in the basalt specimen';
      const bytes = Buffer.from(text);
      const resource = await call('content_resource_create', { resource: {
        id: 'resource-basalt', itemId, title: 'Basalt microscopy', payload: { kind: 'inline-text', text },
        mediaType: 'text/plain', language: 'en', integrity: { algorithm: 'sha256', digest: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength },
      } });
      expect(resource.ok).toBe(true);
      const annotation = await call('content_annotation_create', { annotation: {
        id: 'annotation-basalt', body: { kind: 'text', text: 'Olivine-rich margin' },
        target: { kind: 'resource', sourceId: 'resource-basalt' }, targetVisibility: { version: 1, clauses: [] },
      } });
      expect(annotation.ok).toBe(true);

      const page = await call('search', { text: 'olivine', kinds: ['item', 'resource', 'annotation'], limit: 20 });
      expect(page).toMatchObject({ ok: true });
      const results = (page as { ok: true; value: { results: Array<{ kind: string; sourceId: string }> } }).value.results;
      expect(results.map(({ kind }) => kind)).toEqual(expect.arrayContaining(['resource', 'annotation']));
      const selected = results.find(({ kind }) => kind === 'resource')!;
      await expect(call('search_hydrate', { result: selected })).resolves.toMatchObject({ ok: true, value: { id: 'resource-basalt' } });
      await expect(call('content_resource_hydrate', { id: 'resource-basalt' })).resolves.toMatchObject({ ok: true, value: { bytesBase64: bytes.toString('base64') } });
      const escape = await call('content_resource_create', { resource: {
        id: 'resource-escape', itemId, payload: { kind: 'location', storage: 'blob', location: '../root.key', byteLength: 32 },
        mediaType: 'application/octet-stream', integrity: { algorithm: 'sha256', digest: createHash('sha256').update(Buffer.alloc(32, 0x72)).digest('hex'), byteLength: 32 },
      } });
      expect(escape).toMatchObject({ ok: true });
      await expect(call('content_resource_hydrate', { id: 'resource-escape' })).resolves.toMatchObject({ ok: false, failure: { kind: 'operation' } });
    } finally {
      await runtime.close();
    }
  });
});

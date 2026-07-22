import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createItem, createProperty, TaprootContentRepositoryV1 } from '@gnolith/taproot';
import type { SeedbedConfig } from '../src/config.js';
import { bootstrapAuthorization, openAuthorization } from '../src/authorization.js';
import { initializeDatabase, openDatabase } from '../src/persistence.js';
import { createSeedbedRuntime } from '../src/runtime.js';
import { loadTaprootAssembly } from '../src/taproot-bridge.js';

describe('Taproot content and authorized search assembly', () => {
  it('materializes, hydrates, and rebuilds the complete seven-kind corpus', async () => {
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
    const policy = (context: typeof owner, statementRestrictions: Record<string, readonly []> = {}) => ({
      installationId: context.installationId, workspaceId: context.activeWorkspaceId,
      ownerPrincipalId: context.principalId, visibility: { version: 1 as const, clauses: [] },
      statementRestrictions, expectedAuthorizationRevision: context.authorizationRevision,
    });
    await createProperty(maintenance, { baseIri: config.baseIri! }, authority.authorizationGuard, owner, {
      id: 'P1', datatype: 'string', labels: { en: { language: 'en', value: 'Petrology note' } },
      authorization: policy(owner),
    });
    const itemContext = await authority.resolveContext('owner', 'workspace');
    await createItem(maintenance, { baseIri: config.baseIri! }, authority.authorizationGuard, itemContext, {
      id: 'Q1', labels: { en: { language: 'en', value: 'Petrology basalt sample' } }, descriptions: { en: { language: 'en', value: 'A volcanic stone' } },
      claims: { P1: [{ id: 'Q1$petrology', type: 'statement', text: 'Petrology statement about basalt provenance', rank: 'normal', mainsnak: { snaktype: 'value', property: 'P1', datatype: 'string', datavalue: { type: 'string', value: 'igneous' } }, qualifiers: {}, 'qualifiers-order': [], references: [] }] },
      authorization: policy(itemContext, { 'Q1$petrology': [] }),
    });
    await maintenance.close();
    const runtime = await createSeedbedRuntime(config, taproot);
    const call = (name: string, args: Record<string, unknown>) => runtime.dispatcher.callTool(
      { name, arguments: args }, { principal: runtime.principal, requestId: randomUUID() },
    );
    try {
      const itemId = 'Q1' as const;
      const text = 'Microscopic olivine crystals in the petrology basalt specimen';
      const bytes = Buffer.from(text);
      const resource = await call('content_resource_create', { resource: {
        id: 'resource-basalt', itemId, title: 'Basalt microscopy', payload: { kind: 'inline-text', text },
        mediaType: 'text/plain', language: 'en', integrity: { algorithm: 'sha256', digest: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength },
      } });
      expect(resource.ok).toBe(true);
      const annotation = await call('content_annotation_create', { annotation: {
        id: 'annotation-basalt', body: { kind: 'text', text: 'Petrology annotation for an olivine-rich margin' },
        target: { kind: 'resource', sourceId: 'resource-basalt' }, targetVisibility: { version: 1, clauses: [] },
      } });
      expect(annotation.ok).toBe(true);
      expect((await call('upsert_memory', { slug: 'petrology-memory', description: 'Petrology memory', content: 'Petrology field guidance' })).ok).toBe(true);
      expect((await call('create_task', { description: 'Petrology task', prompt: 'Perform the petrology workflow', memorySlugs: ['petrology-memory'] })).ok).toBe(true);
      expect((await call('create_prompt', { id: 'petrology-prompt', name: 'petrology-prompt', title: 'Petrology prompt', promptText: 'Use the petrology procedure' })).ok).toBe(true);

      let completePage = await call('search', { text: 'petrology', limit: 50 });
      for (let attempt = 0; attempt < 30 && (!completePage.ok || new Set((completePage.value as { results: Array<{ kind: string }> }).results.map(({ kind }) => kind)).size < 7); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        completePage = await call('search', { text: 'petrology', limit: 50 });
      }
      expect(completePage).toMatchObject({ ok: true });
      const completeResults = (completePage as { ok: true; value: { results: Array<{ kind: string; sourceId: string }> } }).value.results;
      expect(new Set(completeResults.map(({ kind }) => kind))).toEqual(new Set(['statement', 'item', 'task', 'memory', 'prompt', 'resource', 'annotation']));
      for (const kind of ['statement', 'item', 'task', 'memory', 'prompt', 'resource', 'annotation']) {
        const result = completeResults.find((candidate) => candidate.kind === kind)!;
        await expect(call('search_hydrate', { result })).resolves.toMatchObject({ ok: true });
      }
      const healthBefore = await call('search_admin_health', {});
      expect(healthBefore).toMatchObject({ ok: true, value: { blockedProducerKinds: [] } });
      const activeGeneration = (healthBefore as { ok: true; value: { activeCorpusGeneration: number } }).value.activeCorpusGeneration;
      await expect(call('search_admin_rebuild', {})).resolves.toMatchObject({ ok: true, value: { shadowCorpusGeneration: activeGeneration + 1 } });
      let activated = false;
      for (let attempt = 0; attempt < 30 && !activated; attempt += 1) {
        await call('search_admin_run', { maxJobs: 100, maxRebuildRoots: 100 });
        const activation = await call('search_admin_activate', {});
        activated = activation.ok;
      }
      expect(activated).toBe(true);
      await expect(call('search_admin_health', {})).resolves.toMatchObject({ ok: true, value: { activeCorpusGeneration: activeGeneration + 1, shadowCorpusGeneration: null, blockedProducerKinds: [] } });
      await expect(call('search', { text: 'petrology', limit: 50 })).resolves.toMatchObject({ ok: true, value: { results: expect.arrayContaining([expect.objectContaining({ kind: 'prompt', sourceId: 'petrology-prompt' })]) } });

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
      const sparql = await call('sparql_query', { query: 'SELECT ?label WHERE { <https://search.seedbed.test/installation/entity/Q1> <http://www.w3.org/2000/01/rdf-schema#label> ?label }' });
      expect(sparql).toMatchObject({ ok: true, value: { mediaType: expect.stringContaining('application/sparql-results+json'), body: expect.stringContaining('Petrology basalt sample') } });

      const direct = new TaprootContentRepositoryV1(runtime.database, { installationId: runtime.principal.installationId });
      const current = await openAuthorization(runtime.database, config).then((bundle) => bundle.resolveContext('owner', 'workspace'));
      const idleText = 'background-only chrysotile projection';
      await direct.createResource({ id: 'resource-background', itemId, payload: { kind: 'inline-text', text: idleText }, mediaType: 'text/plain', integrity: { algorithm: 'sha256', digest: createHash('sha256').update(idleText).digest('hex'), byteLength: Buffer.byteLength(idleText) } }, { context: current, attribution: { id: 'owner', kind: 'human' }, workspaceId: 'workspace', ownerPrincipalId: 'owner', visibility: { version: 1, clauses: [] }, expectedAuthorizationRevision: current.authorizationRevision });
      let backgroundFound = false;
      for (let attempt = 0; attempt < 20 && !backgroundFound; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const result = await call('search', { text: 'chrysotile', kinds: ['resource'], limit: 5 });
        backgroundFound = result.ok && (result.value as { results: Array<{ sourceId: string }> }).results.some(({ sourceId }) => sourceId === 'resource-background');
      }
      expect(backgroundFound).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});

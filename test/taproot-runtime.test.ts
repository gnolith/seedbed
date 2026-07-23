import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaprootContentRepositoryV1 } from '@gnolith/taproot';
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
    await bootstrapAuthorization(maintenance, config, 'owner', 'workspace');
    await maintenance.close();
    const runtime = await createSeedbedRuntime(config, taproot);
    const call = (name: string, args: Record<string, unknown>) => runtime.dispatcher.callTool(
      { name, arguments: args }, { principal: runtime.principal, requestId: randomUUID() },
    );
    try {
      const itemId = 'Q1' as const;
      await expect(call('create_property', {
        id: 'P1', datatype: 'string', labels: { en: { language: 'en', value: 'Petrology note' } },
      })).resolves.toMatchObject({ ok: true, value: { entityId: 'P1' } });
      await expect(call('create_item', {
        id: itemId, labels: { en: { language: 'en', value: 'Petrology basalt sample' } }, descriptions: { en: { language: 'en', value: 'A volcanic stone' } },
        claims: { P1: [{ id: 'Q1$petrology', type: 'statement', text: 'Petrology statement about basalt provenance', rank: 'normal', mainsnak: { snaktype: 'value', property: 'P1', datatype: 'string', datavalue: { type: 'string', value: 'igneous' } }, qualifiers: {}, 'qualifiers-order': [], references: [] }] },
        statementRestrictions: { 'Q1$petrology': [] },
      })).resolves.toMatchObject({ ok: true, value: { entityId: itemId } });
      const mutationTools = runtime.dispatcher.tools.filter(({ name }) => [
        'create_item', 'set_label', 'set_description', 'add_statement', 'remove_statement',
      ].includes(name));
      expect(mutationTools).toHaveLength(5);
      for (const tool of mutationTools) expect(Object.keys(tool.inputSchema.properties).length).toBeGreaterThan(0);
      expect(mutationTools.find(({ name }) => name === 'set_label')?.inputSchema).toMatchObject({
        properties: { expectedRevision: { type: 'integer' }, statementRestrictions: { type: 'object' } },
        required: expect.arrayContaining(['entityId', 'expectedRevision']),
        additionalProperties: false,
      });

      await expect(call('set_label', { entityId: itemId, language: 'en', value: 'Petrology basalt specimen', expectedRevision: 1 }))
        .resolves.toMatchObject({ ok: true, value: { entityId: itemId, newRevision: 2 } });
      let policyRows = await runtime.database.prepare(`SELECT statement_id, restrictions_json
        FROM taproot_statement_authorization WHERE entity_id = ?`).bind(itemId)
        .all<{ statement_id: string; restrictions_json: string }>();
      expect(policyRows.results).toEqual([{ statement_id: 'Q1$petrology', restrictions_json: '[]' }]);

      const ownerOnly = { version: 1, clauses: [[{ kind: 'principal', principalId: 'owner' }]] };
      await expect(call('set_description', {
        entityId: itemId, language: 'en', value: 'A restricted volcanic stone', expectedRevision: 2,
        statementRestrictions: { 'Q1$petrology': [ownerOnly] },
      })).resolves.toMatchObject({ ok: true, value: { entityId: itemId, newRevision: 3 } });
      policyRows = await runtime.database.prepare(`SELECT statement_id, restrictions_json
        FROM taproot_statement_authorization WHERE entity_id = ?`).bind(itemId)
        .all<{ statement_id: string; restrictions_json: string }>();
      expect(JSON.parse(policyRows.results[0]!.restrictions_json)).toEqual([ownerOnly]);
      await expect(call('set_label', { entityId: itemId, language: 'en', value: 'stale', expectedRevision: 2 }))
        .resolves.toMatchObject({ ok: false, failure: { error: { code: 'conflict', message: expect.not.stringContaining('Workshop operation failed') } } });
      await expect(call('set_label', {
        entityId: itemId, language: 'en', value: 'invalid policy', expectedRevision: 3, statementRestrictions: {},
      })).resolves.toMatchObject({ ok: false, failure: { error: { code: 'validation_failed', message: expect.stringContaining('exactly match') } } });

      await expect(call('item_revision', { entityId: itemId, revision: 2 })).resolves.toMatchObject({ ok: true, value: { revision: 2 } });
      await expect(call('item_history', { entityId: itemId, limit: 2 })).resolves.toMatchObject({ ok: true, value: { items: [{ revision: 3 }, { revision: 2 }] } });
      await expect(call('statement_revision', { entityId: itemId, statementId: 'Q1$petrology', revision: 3 }))
        .resolves.toMatchObject({ ok: true, value: { statement: { id: 'Q1$petrology' } } });
      await expect(call('statement_history', { entityId: itemId, statementId: 'Q1$petrology', limit: 2 }))
        .resolves.toMatchObject({ ok: true, value: { items: [
          expect.objectContaining({ revision: 3, statement: expect.objectContaining({ id: 'Q1$petrology' }) }),
          expect.objectContaining({ revision: 2, statement: expect.objectContaining({ id: 'Q1$petrology' }) }),
        ] } });
      const text = 'Microscopic olivine crystals in the petrology basalt specimen';
      const bytes = Buffer.from(text);
      const resource = await call('content_resource_create', { resource: {
        id: 'resource-basalt', itemId, title: 'Basalt microscopy', payload: { kind: 'inline-text', text },
        mediaType: 'text/plain', language: 'en', integrity: { algorithm: 'sha256', digest: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength },
      } });
      expect(resource.ok).toBe(true);
      await expect(call('resource_revision', { id: 'resource-basalt', revision: 1 })).resolves.toMatchObject({ ok: true, value: { id: 'resource-basalt', revision: 1 } });
      await expect(call('resource_history', { id: 'resource-basalt', limit: 10 })).resolves.toMatchObject({ ok: true, value: { items: [{ id: 'resource-basalt', revision: 1 }] } });
      const annotation = await call('content_annotation_create', { annotation: {
        id: 'annotation-basalt', body: { kind: 'text', text: 'Petrology annotation for an olivine-rich margin' },
        target: { kind: 'resource', sourceId: 'resource-basalt' }, targetVisibility: { version: 1, clauses: [] },
      } });
      expect(annotation.ok).toBe(true);
      await expect(call('annotation_revision', { id: 'annotation-basalt', revision: 1 })).resolves.toMatchObject({ ok: true, value: { id: 'annotation-basalt', revision: 1 } });
      await expect(call('annotation_history', { id: 'annotation-basalt', limit: 10 })).resolves.toMatchObject({ ok: true, value: { items: [{ id: 'annotation-basalt', revision: 1 }] } });
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
      await expect(call('search', { text: 'provenance', kinds: ['item'], limit: 10 })).resolves.toMatchObject({
        ok: true, value: { results: [expect.objectContaining({ kind: 'item', sourceId: itemId })] },
      });
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
      const sparql = await call('query_sparql', { query: 'SELECT ?label WHERE { <https://search.seedbed.test/installation/entity/Q1> <http://www.w3.org/2000/01/rdf-schema#label> ?label }' });
      expect(sparql).toMatchObject({ ok: true, value: { mediaType: expect.stringContaining('application/sparql-results+json'), body: expect.stringContaining('Petrology basalt specimen') } });

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

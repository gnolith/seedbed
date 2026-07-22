import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SeedbedConfig } from '../src/config.js';
import { bootstrapAuthorization, replacePrincipalAuthorization } from '../src/authorization.js';
import { createSeedbedRuntime } from '../src/runtime.js';
import { initializeDatabase, openDatabase } from '../src/persistence.js';
import { loadTaprootAssembly } from '../src/taproot-bridge.js';

describe('native headless combined runtime', () => {
  it('persists authorized Task and Memory operations across process-style reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seedbed-runtime-system-'));
    const secret = join(directory, 'root.key');
    await writeFile(secret, Buffer.alloc(32, 0x53), { mode: 0o600 });
    const config: SeedbedConfig = {
      databasePath: join(directory, 'gnolith.sqlite'),
      baseIri: 'https://runtime.seedbed.test/installation/',
      rootSecretFile: secret,
      principalSelector: 'agent',
      workspaceSelector: 'workspace',
      logLevel: 'silent',
      shutdownTimeoutMs: 1_000,
    };
    const taproot = await loadTaprootAssembly();
    await initializeDatabase(config, taproot);
    const maintenance = await openDatabase(config);
    try {
      await bootstrapAuthorization(maintenance, config, 'agent', 'workspace');
    } finally {
      await maintenance.close();
    }

    let runtime = await createSeedbedRuntime(config, taproot);
    const call = (name: string, argumentsValue: Record<string, unknown>) => runtime.dispatcher.callTool(
      { name, arguments: argumentsValue },
      { principal: runtime.principal, requestId: randomUUID() },
    );
    expect((await call('upsert_memory', { slug: 'restart-proof', description: 'Restart proof', content: 'Durable guidance' })).ok).toBe(true);
    const created = await call('create_task', { description: 'Combined test', prompt: 'Verify the headless assembly', memorySlugs: ['restart-proof'] });
    expect(created.ok).toBe(true);
    const taskId = created.ok ? (created.value as { id: string }).id : '';
    await runtime.close();

    runtime = await createSeedbedRuntime(config, taproot);
    try {
      const memory = await call('get_memory', { slug: 'restart-proof' });
      const task = await call('get_task_packet', { id: taskId });
      expect(memory).toMatchObject({ ok: true, value: { slug: 'restart-proof' } });
      expect(task).toMatchObject({ ok: true, value: { task: { id: taskId } } });
      expect(runtime.dispatcher.tools.map(({ name }) => name)).toEqual(expect.arrayContaining(['validate_sparql', 'dry_run_sparql', 'query_sparql']));
    } finally {
      await runtime.close();
    }
  });

  it('invalidates a live process and its issued cursor immediately after a second-process revoke', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seedbed-runtime-revoke-'));
    const secret = join(directory, 'root.key');
    await writeFile(secret, Buffer.alloc(32, 0x54), { mode: 0o600 });
    const ownerConfig: SeedbedConfig = {
      databasePath: join(directory, 'gnolith.sqlite'),
      baseIri: 'https://runtime.seedbed.test/revoke/',
      rootSecretFile: secret,
      principalSelector: 'owner',
      workspaceSelector: 'workspace',
      logLevel: 'silent',
      shutdownTimeoutMs: 1_000,
    };
    const taproot = await loadTaprootAssembly();
    await initializeDatabase(ownerConfig, taproot);
    const maintenance = await openDatabase(ownerConfig);
    const owner = await bootstrapAuthorization(maintenance, ownerConfig, 'owner', 'workspace');
    const worker = await replacePrincipalAuthorization(maintenance, ownerConfig, 'owner', 'workspace', {
      expectedAuthorizationRevision: owner.authorizationRevision,
      principalSelector: 'worker',
      enabled: true,
      workspaceSelectors: ['workspace'],
      capabilities: ['read'],
    });
    await maintenance.close();

    const ownerRuntime = await createSeedbedRuntime(ownerConfig, taproot);
    const ownerCall = (name: string, argumentsValue: Record<string, unknown>) => ownerRuntime.dispatcher.callTool(
      { name, arguments: argumentsValue },
      { principal: ownerRuntime.principal, requestId: randomUUID() },
    );
    await ownerCall('upsert_memory', { slug: 'cursor-a', description: 'Cursor A', content: 'A' });
    await ownerCall('upsert_memory', { slug: 'cursor-b', description: 'Cursor B', content: 'B' });
    await ownerRuntime.close();

    const workerConfig = { ...ownerConfig, principalSelector: 'worker' };
    const workerRuntime = await createSeedbedRuntime(workerConfig, taproot);
    const workerCall = (name: string, argumentsValue: Record<string, unknown>) => workerRuntime.dispatcher.callTool(
      { name, arguments: argumentsValue },
      { principal: workerRuntime.principal, requestId: randomUUID() },
    );
    expect(workerRuntime.dispatcher.listTools(workerRuntime.principal)).toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({ name: 'validate_sparql', capability: 'read' }),
        expect.objectContaining({ name: 'dry_run_sparql', capability: 'read' }),
        expect.objectContaining({ name: 'query_sparql', capability: 'read' }),
      ]),
    });
    await expect(workerCall('query_sparql', { query: 'SELECT * WHERE { ?s ?p ?o }' })).resolves.toMatchObject({ ok: true });
    await expect(workerCall('query_sparql', { query: 'INSERT DATA { <urn:s> <urn:p> <urn:o> }' })).resolves.toMatchObject({ ok: false, failure: { kind: 'operation' } });
    const page = await workerCall('list_memories', { limit: 1 });
    expect(page).toMatchObject({ ok: true, value: { items: [{ slug: expect.any(String) }], cursor: expect.any(String) } });
    const cursor = page.ok ? (page.value as { cursor: string }).cursor : '';

    const revoker = await openDatabase(ownerConfig);
    try {
      await replacePrincipalAuthorization(revoker, ownerConfig, 'owner', 'workspace', {
        expectedAuthorizationRevision: worker.authorizationRevision,
        principalSelector: 'worker',
        enabled: false,
        workspaceSelectors: [],
        capabilities: [],
      });
    } finally {
      await revoker.close();
    }
    try {
      await expect(workerCall('list_memories', { limit: 1, cursor })).resolves.toMatchObject({
        ok: false,
        failure: { kind: 'forbidden' },
      });
    } finally {
      await workerRuntime.close();
    }
    await expect(createSeedbedRuntime(workerConfig, taproot)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('keeps Taproot knowledge writes and read-only SPARQL on their exact asymmetric grants', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seedbed-runtime-exact-capabilities-'));
    const secret = join(directory, 'root.key');
    await writeFile(secret, Buffer.alloc(32, 0x55), { mode: 0o600 });
    const baseConfig: SeedbedConfig = {
      databasePath: join(directory, 'gnolith.sqlite'),
      blobPath: join(directory, 'blobs'),
      baseIri: 'https://runtime.seedbed.test/exact-capabilities/',
      rootSecretFile: secret,
      principalSelector: 'owner',
      workspaceSelector: 'workspace',
      logLevel: 'silent',
      shutdownTimeoutMs: 1_000,
    };
    const taproot = await loadTaprootAssembly();
    await initializeDatabase(baseConfig, taproot);
    const maintenance = await openDatabase(baseConfig);
    try {
      let authorizationRevision = (await bootstrapAuthorization(maintenance, baseConfig, 'owner', 'workspace')).authorizationRevision;
      for (const [principalSelector, capabilities] of [
        ['legacy-writer', ['read', 'knowledge-write']],
        ['taproot-writer', ['read', 'knowledge:write']],
        ['reader', ['read']],
        ['policy-only', ['knowledge:policy']],
        ['admin-only', ['admin']],
      ] as const) {
        const state = await replacePrincipalAuthorization(maintenance, baseConfig, 'owner', 'workspace', {
          expectedAuthorizationRevision: authorizationRevision,
          principalSelector,
          enabled: true,
          workspaceSelectors: ['workspace'],
          capabilities,
        });
        authorizationRevision = state.authorizationRevision;
      }
    } finally {
      await maintenance.close();
    }

    const openFor = async (principalSelector: string) => createSeedbedRuntime({ ...baseConfig, principalSelector }, taproot);
    const call = (runtime: Awaited<ReturnType<typeof createSeedbedRuntime>>, name: string, args: Record<string, unknown>) => runtime.dispatcher.callTool(
      { name, arguments: args }, { principal: runtime.principal, requestId: randomUUID() },
    );
    const taprootMutations = [
      'create_item', 'create_property', 'set_label', 'set_description', 'add_alias', 'remove_alias',
      'add_sitelink', 'remove_sitelink', 'add_statement', 'replace_statement', 'remove_statement',
      'set_statement_rank', 'add_qualifier', 'remove_qualifier', 'add_reference', 'remove_reference',
      'content_resource_create', 'content_resource_update', 'content_resource_delete',
      'content_annotation_create', 'content_annotation_update', 'content_annotation_delete',
    ];

    const legacy = await openFor('legacy-writer');
    try {
      const listed = legacy.dispatcher.listTools(legacy.principal);
      expect(listed).toMatchObject({ ok: true });
      if (listed.ok) expect(listed.value.map(({ name }) => name)).not.toEqual(expect.arrayContaining(taprootMutations));
      await expect(call(legacy, 'create_item', { id: 'Q1' })).resolves.toMatchObject({ ok: false, failure: { kind: 'forbidden' } });
    } finally {
      await legacy.close();
    }

    const writer = await openFor('taproot-writer');
    try {
      const listed = writer.dispatcher.listTools(writer.principal);
      expect(listed).toMatchObject({ ok: true });
      if (listed.ok) {
        for (const name of taprootMutations) expect(listed.value).toContainEqual(expect.objectContaining({ name, capability: 'knowledge:write' }));
        expect(listed.value).toContainEqual(expect.objectContaining({ name: 'query_sparql', capability: 'read' }));
      }
      await expect(call(writer, 'create_item', { id: 'Q1', labels: {}, descriptions: {}, claims: {}, statementRestrictions: {} }))
        .resolves.toMatchObject({ ok: true, value: { entityId: 'Q1' } });
      await expect(call(writer, 'query_sparql', { query: 'ASK {}' })).resolves.toMatchObject({ ok: true });
    } finally {
      await writer.close();
    }

    const reader = await openFor('reader');
    try {
      const listed = reader.dispatcher.listTools(reader.principal);
      expect(listed).toMatchObject({ ok: true });
      if (listed.ok) {
        for (const name of ['validate_sparql', 'dry_run_sparql', 'query_sparql']) {
          expect(listed.value).toContainEqual(expect.objectContaining({ name, capability: 'read' }));
        }
        expect(listed.value.map(({ name }) => name)).not.toEqual(expect.arrayContaining(taprootMutations));
      }
      await expect(call(reader, 'validate_sparql', { query: 'ASK {}' })).resolves.toMatchObject({ ok: true, value: { valid: true, dryRun: false } });
      await expect(call(reader, 'dry_run_sparql', { query: 'ASK {}' })).resolves.toMatchObject({ ok: true, value: { valid: true, dryRun: true } });
      await expect(call(reader, 'query_sparql', { query: 'ASK {}' })).resolves.toMatchObject({ ok: true, value: { body: expect.any(String) } });
      await expect(call(reader, 'query_sparql', { query: 'INSERT DATA { <urn:s> <urn:p> <urn:o> }' })).resolves.toMatchObject({ ok: false, failure: { kind: 'operation' } });
    } finally {
      await reader.close();
    }

    for (const principalSelector of ['policy-only', 'admin-only']) {
      const runtime = await openFor(principalSelector);
      try {
        const listed = runtime.dispatcher.listTools(runtime.principal);
        expect(listed).toMatchObject({ ok: false, failure: { kind: 'forbidden' } });
        await expect(call(runtime, 'query_sparql', { query: 'ASK {}' })).resolves.toMatchObject({ ok: false, failure: { kind: 'forbidden' } });
      } finally {
        await runtime.close();
      }
    }
  });
});

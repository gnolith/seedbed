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
      expect(runtime.dispatcher.tools.map(({ name }) => name)).not.toContain('query_sparql');
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
});

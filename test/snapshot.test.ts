import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SeedbedConfig } from '../src/config.js';
import { initializeDatabase } from '../src/persistence.js';
import { bootstrapAuthorization } from '../src/authorization.js';
import { openDatabase } from '../src/persistence.js';
import { createSeedbedRuntime } from '../src/runtime.js';
import { loadTaprootAssembly } from '../src/taproot-bridge.js';
import {
  createInstallationSnapshot,
  inspectInstallationSnapshot,
  restoreInstallationSnapshot,
} from '../src/snapshot.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('portable installation snapshots', () => {
  it('round trips canonical state and blobs without exporting root-secret material', async () => {
    const source = await fixture('source');
    const target = await fixture('target', source.secretBytes);
    const snapshotPath = join(source.directory, 'portable.seedbed-snapshot.gz');
    const taproot = await loadTaprootAssembly();
    await initializeDatabase(source.config, taproot);
    const bootstrapDb = await openDatabase(source.config);
    const context = await bootstrapAuthorization(bootstrapDb, source.config, 'owner', 'workspace');
    await bootstrapDb.close();

    const runtime = await createSeedbedRuntime(source.config, taproot);
    const created = await runtime.dispatcher.callTool(
      { name: 'upsert_memory', arguments: { slug: 'snapshot-proof', description: 'Portable', content: 'Canonical state' } },
      { principal: runtime.principal, requestId: randomUUID() },
    );
    expect(created.ok).toBe(true);
    await runtime.close();
    await mkdir(join(source.config.blobPath!, 'nested'), { recursive: true });
    await writeFile(join(source.config.blobPath!, 'nested', 'payload.bin'), Buffer.from([0, 1, 2, 255]));

    const createdSnapshot = await createInstallationSnapshot(source.config, taproot, snapshotPath, new Date('2026-07-22T12:00:00.000Z'));
    expect(createdSnapshot.manifest).toMatchObject({
      format: 'gnolith-seedbed-snapshot-v1',
      installationId: context.installationId,
      createdAt: '2026-07-22T12:00:00.000Z',
      secretsExported: false,
      blobs: [{ path: 'nested/payload.bin', bytes: 4 }],
    });
    const decompressed = gunzipSync(await readFile(snapshotPath));
    expect(decompressed.includes(Buffer.from(source.secretBytes))).toBe(false);
    expect(decompressed.toString('utf8')).not.toContain(Buffer.from(source.secretBytes).toString('base64'));
    expect(await inspectInstallationSnapshot(snapshotPath, true)).toMatchObject({ valid: true });

    const restored = await restoreInstallationSnapshot(target.config, taproot, snapshotPath);
    expect(restored.manifest.installationId).toBe(context.installationId);
    expect(await readFile(join(target.config.blobPath!, 'nested', 'payload.bin'))).toEqual(Buffer.from([0, 1, 2, 255]));
    const restoredRuntime = await createSeedbedRuntime(target.config, taproot);
    try {
      const memory = await restoredRuntime.dispatcher.callTool(
        { name: 'get_memory', arguments: { slug: 'snapshot-proof' } },
        { principal: restoredRuntime.principal, requestId: randomUUID() },
      );
      expect(memory).toMatchObject({ ok: true, value: { slug: 'snapshot-proof', content: 'Canonical state' } });
    } finally {
      await restoredRuntime.close();
    }
  });

  it('rejects tampering and refuses to replace an existing canonical installation', async () => {
    const source = await fixture('source-tamper');
    const target = await fixture('target-tamper', source.secretBytes);
    const taproot = await loadTaprootAssembly();
    await initializeDatabase(source.config, taproot);
    const db = await openDatabase(source.config);
    await bootstrapAuthorization(db, source.config, 'owner', 'workspace');
    await db.close();
    const snapshotPath = join(source.directory, 'snapshot.gz');
    await createInstallationSnapshot(source.config, taproot, snapshotPath);

    const envelope = JSON.parse(gunzipSync(await readFile(snapshotPath)).toString('utf8')) as { database: string };
    envelope.database = `${envelope.database.slice(0, -4)}AAAA`;
    const tamperedPath = join(source.directory, 'tampered.gz');
    await writeFile(tamperedPath, gzipSync(Buffer.from(JSON.stringify(envelope))));
    await expect(inspectInstallationSnapshot(tamperedPath, true)).rejects.toMatchObject({ code: 'snapshot_invalid' });

    const secretFieldEnvelope = JSON.parse(gunzipSync(await readFile(snapshotPath)).toString('utf8')) as {
      manifest: Record<string, unknown>;
    };
    secretFieldEnvelope.manifest.providerCredential = 'PROVIDER_CREDENTIAL_CANARY';
    const secretFieldPath = join(source.directory, 'secret-field.gz');
    await writeFile(secretFieldPath, gzipSync(Buffer.from(JSON.stringify(secretFieldEnvelope))));
    await expect(inspectInstallationSnapshot(secretFieldPath)).rejects.toMatchObject({ code: 'snapshot_invalid' });

    await initializeDatabase(target.config, taproot);
    const before = await readFile(target.config.databasePath);
    await expect(restoreInstallationSnapshot(target.config, taproot, snapshotPath)).rejects.toMatchObject({ code: 'restore_target_exists' });
    expect(await readFile(target.config.databasePath)).toEqual(before);
  });

  it('cleans an interrupted restore before exposing a canonical database', async () => {
    const source = await fixture('source-interrupt');
    const target = await fixture('target-interrupt', source.secretBytes);
    const taproot = await loadTaprootAssembly();
    await initializeDatabase(source.config, taproot);
    const db = await openDatabase(source.config);
    await bootstrapAuthorization(db, source.config, 'owner', 'workspace');
    await db.close();
    await mkdir(source.config.blobPath!, { recursive: true });
    await writeFile(join(source.config.blobPath!, 'blob'), 'complete');
    const snapshotPath = join(source.directory, 'snapshot.gz');
    await createInstallationSnapshot(source.config, taproot, snapshotPath);

    await expect(restoreInstallationSnapshot(target.config, taproot, snapshotPath, {
      afterBlobsInstalled() { throw new Error('deterministic interruption'); },
    })).rejects.toThrow('deterministic interruption');
    await expect(stat(target.config.databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(target.config.blobPath!)).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(restoreInstallationSnapshot(target.config, taproot, snapshotPath)).resolves.toMatchObject({ valid: true });
  });

  it('verifies and restores a 32 MiB+ archive with bounded validation and retry-safe interruptions', { timeout: 120_000 }, async () => {
    const source = await fixture('source-large');
    const target = await fixture('target-large', source.secretBytes);
    const taproot = await loadTaprootAssembly();
    await initializeDatabase(source.config, taproot);
    const db = await openDatabase(source.config);
    await bootstrapAuthorization(db, source.config, 'owner', 'workspace');
    await db.close();
    const large = Buffer.alloc((32 * 1024 * 1024) + 17);
    for (let index = 0; index < large.length; index += 1) large[index] = index % 251;
    await mkdir(join(source.config.blobPath!, 'large'), { recursive: true });
    await writeFile(join(source.config.blobPath!, 'large', 'payload.bin'), large);

    const snapshotPath = join(source.directory, 'large.gz');
    await expect(createInstallationSnapshot(source.config, taproot, snapshotPath, new Date('2026-07-22T12:00:00.000Z'), {
      afterArchiveVerified() { throw new Error('deterministic export interruption'); },
    })).rejects.toThrow('deterministic export interruption');
    await expect(stat(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(createInstallationSnapshot(source.config, taproot, snapshotPath)).resolves.toMatchObject({ valid: true });
    await expect(inspectInstallationSnapshot(snapshotPath)).resolves.toMatchObject({ valid: true });
    await expect(inspectInstallationSnapshot(snapshotPath, true)).resolves.toMatchObject({ valid: true });

    const rawArchive = gunzipSync(await readFile(snapshotPath));
    expect(rawArchive.includes(Buffer.from(source.secretBytes))).toBe(false);
    expect(rawArchive.toString('utf8')).not.toContain(Buffer.from(source.secretBytes).toString('base64'));
    const envelope = JSON.parse(rawArchive.toString('utf8')) as { blobs: Array<{ data: string }> };
    const middle = Math.floor(envelope.blobs[0]!.data.length / 2);
    const original = envelope.blobs[0]!.data[middle]!;
    envelope.blobs[0]!.data = `${envelope.blobs[0]!.data.slice(0, middle)}${original === 'A' ? 'B' : 'A'}${envelope.blobs[0]!.data.slice(middle + 1)}`;
    const tampered = join(source.directory, 'large-tampered.gz');
    await writeFile(tampered, gzipSync(Buffer.from(JSON.stringify(envelope))));
    await expect(inspectInstallationSnapshot(tampered, true)).rejects.toMatchObject({ code: 'snapshot_invalid' });

    await expect(restoreInstallationSnapshot(target.config, taproot, snapshotPath)).resolves.toMatchObject({ valid: true });
    const restored = await readFile(join(target.config.blobPath!, 'large', 'payload.bin'));
    expect(restored.byteLength).toBe(large.byteLength);
    expect(createHash('sha256').update(restored).digest('hex')).toBe(createHash('sha256').update(large).digest('hex'));

    const wrongRoot = await fixture('target-wrong-root', Buffer.alloc(32, 0x5a));
    await expect(restoreInstallationSnapshot(wrongRoot.config, taproot, snapshotPath)).rejects.toBeDefined();
    await expect(stat(wrongRoot.config.databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(wrongRoot.config.blobPath!)).rejects.toMatchObject({ code: 'ENOENT' });

    const nonempty = await fixture('target-nonempty', source.secretBytes);
    await mkdir(nonempty.config.blobPath!, { recursive: true });
    await writeFile(join(nonempty.config.blobPath!, 'canary'), 'do not replace');
    await expect(restoreInstallationSnapshot(nonempty.config, taproot, snapshotPath)).rejects.toMatchObject({ code: 'restore_target_exists' });
    await expect(readFile(join(nonempty.config.blobPath!, 'canary'), 'utf8')).resolves.toBe('do not replace');
  });

  it('restores compatible chunks and replaces missing or incompatible chunks from canonical state', { timeout: 30_000 }, async () => {
    const source = await fixture('source-derived');
    const taproot = await loadTaprootAssembly();
    await initializeDatabase(source.config, taproot);
    const bootstrapDb = await openDatabase(source.config);
    await bootstrapAuthorization(bootstrapDb, source.config, 'owner', 'workspace');
    await bootstrapDb.close();
    let runtime = await createSeedbedRuntime(source.config, taproot);
    const call = (name: string, args: Record<string, unknown>) => runtime.dispatcher.callTool(
      { name, arguments: args }, { principal: runtime.principal, requestId: randomUUID() },
    );
    await expect(call('upsert_memory', { slug: 'derived-proof', description: 'Canonical chrysotile record', content: 'Canonical chrysotile survives derived replacement' })).resolves.toMatchObject({ ok: true });
    await runtime.close();

    const compatible = join(source.directory, 'compatible.gz');
    await createInstallationSnapshot(source.config, taproot, compatible);
    const mutationDb = await openDatabase(source.config);
    const chunks = await mutationDb.prepare('SELECT COUNT(*) AS count FROM taproot_search_chunks').all<{ count: number }>();
    expect(Number(chunks.results[0]?.count ?? 0)).toBeGreaterThan(0);
    await mutationDb.prepare('DELETE FROM taproot_search_chunks').run();
    await mutationDb.close();
    const missing = join(source.directory, 'missing.gz');
    await createInstallationSnapshot(source.config, taproot, missing);

    runtime = await createSeedbedRuntime(source.config, taproot);
    await rebuildActiveCorpus(call);
    await runtime.close();
    const incompatibleDb = await openDatabase(source.config);
    await incompatibleDb.prepare("UPDATE taproot_search_chunks SET chunk_text = 'deliberately incompatible derived text'").run();
    await incompatibleDb.close();
    const incompatible = join(source.directory, 'incompatible.gz');
    await createInstallationSnapshot(source.config, taproot, incompatible);

    for (const [name, snapshot] of [['compatible', compatible], ['missing', missing], ['incompatible', incompatible]] as const) {
      const target = await fixture(`target-${name}`, source.secretBytes);
      await restoreInstallationSnapshot(target.config, taproot, snapshot);
      runtime = await createSeedbedRuntime(target.config, taproot);
      await rebuildActiveCorpus(call);
      const result = await call('search', { text: 'chrysotile', kinds: ['memory'], limit: 5 });
      expect(result).toMatchObject({ ok: true, value: { results: [expect.objectContaining({ sourceId: 'derived-proof' })] } });
      await runtime.close();
    }
  });
});

async function rebuildActiveCorpus(call: (name: string, args: Record<string, unknown>) => Promise<unknown>): Promise<void> {
  const started = await call('search_admin_rebuild', {}) as { ok: boolean };
  expect(started.ok).toBe(true);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await call('search_admin_run', { maxJobs: 100, maxRebuildRoots: 100 });
    const activated = await call('search_admin_activate', {}) as { ok: boolean };
    if (activated.ok) return;
  }
  throw new Error('derived-state rebuild did not become activatable');
}

async function fixture(name: string, secretBytes: Uint8Array = Buffer.from('ROOT_SECRET_CANARY_1234567890ABC')): Promise<{
  directory: string;
  secretBytes: Uint8Array;
  config: SeedbedConfig;
}> {
  expect(secretBytes.byteLength).toBe(32);
  const directory = await mkdtemp(join(tmpdir(), `seedbed-${name}-`));
  directories.push(directory);
  const secretPath = join(directory, 'root.key');
  await writeFile(secretPath, secretBytes, { mode: 0o600 });
  return {
    directory,
    secretBytes,
    config: {
      databasePath: join(directory, 'gnolith.sqlite'),
      blobPath: join(directory, 'blobs'),
      busyTimeoutMs: 1_000,
      baseIri: 'https://snapshot.seedbed.test/installation/',
      rootSecretFile: secretPath,
      principalSelector: 'owner',
      workspaceSelector: 'workspace',
      logLevel: 'silent',
      shutdownTimeoutMs: 1_000,
    },
  };
}

import { randomUUID } from 'node:crypto';
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
});

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

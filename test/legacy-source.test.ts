import { gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256 } from '../src/canonical.js';
import {
  OperatorLegacyDecoder,
  preparePortableLegacySource,
  type LegacyAdapterExecutor,
  type PortableLegacySource,
} from '../src/legacy-source.js';
import { validateLegacyManifest } from '../src/adoption.js';
import { fixtureConfig } from './helpers.js';

const packages = { diamond: '0.4.1', taproot: '0.4.2', workshop: '0.4.2', seedbed: '0.3.2' } as const;

describe('legacy source capability boundary', () => {
  it('decodes and verifies the exact snapshot-v1 envelope without changing the source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-legacy-source-'));
    const config = fixtureConfig(root);
    const database = Buffer.from('opaque portable database');
    const payload = Buffer.from('opaque resource payload');
    const snapshotPath = join(root, 'legacy.snapshot.gz');
    const envelope = {
      manifest: {
        format: 'gnolith-seedbed-snapshot-v1',
        createdAt: '2026-07-23T00:00:00.000Z',
        installationId: config.installationId,
        baseIri: config.baseIri,
        packages,
        database: { bytes: database.byteLength, sha256: sha256(database) },
        blobs: [{ path: 'nested/payload.bin', bytes: payload.byteLength, sha256: sha256(payload) }],
        secretsExported: false,
        derivedStatePolicy: 'validate-compatible-or-discard-and-rebuild',
      },
      database: database.toString('base64'),
      blobs: [{
        path: 'nested/payload.bin',
        bytes: payload.byteLength,
        sha256: sha256(payload),
        data: payload.toString('base64'),
      }],
    };
    await writeFile(snapshotPath, gzipSync(Buffer.from(JSON.stringify(envelope))));
    const before = await readFile(snapshotPath);
    const manifest = validateLegacyManifest({
      format: 'gnolith-legacy-local-adoption-v1',
      source: { kind: 'seedbed-snapshot', snapshotPath },
      expectedInstallationId: config.installationId,
      expectedBaseIri: config.baseIri,
      expectedPackages: packages,
      targetComposeProject: config.compose.projectName,
    });
    const source = await preparePortableLegacySource(manifest, config);
    expect(source.kind).toBe('read-only-portable-source-v1');
    await expect(readFile(source.databasePath)).resolves.toEqual(database);
    await expect(readFile(join(source.blobPath, 'nested', 'payload.bin'))).resolves.toEqual(payload);
    await expect(readFile(snapshotPath)).resolves.toEqual(before);

    envelope.blobs[0]!.data = Buffer.from('tampered').toString('base64');
    const tamperedPath = join(root, 'tampered.snapshot.gz');
    await writeFile(tamperedPath, gzipSync(Buffer.from(JSON.stringify(envelope))));
    const tamperedManifest = validateLegacyManifest({
      ...manifest,
      source: { kind: 'seedbed-snapshot', snapshotPath: tamperedPath },
    });
    await expect(preparePortableLegacySource(tamperedManifest, config)).rejects.toThrow(/size or digest/u);
  });

  it('injects the checksum-pinned owner binding and streams Taproot payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-legacy-adapters-'));
    const config = fixtureConfig(root);
    const databasePath = join(root, 'legacy.sqlite');
    const blobPath = join(root, 'blobs');
    await writeFile(databasePath, 'opaque');
    await mkdir(blobPath);
    const manifest = validateLegacyManifest({
      format: 'gnolith-legacy-local-adoption-v1',
      source: { kind: 'database-and-blobs', databasePath, blobPath },
      expectedInstallationId: config.installationId,
      expectedBaseIri: config.baseIri,
      expectedPackages: packages,
      targetComposeProject: config.compose.projectName,
    });
    const calls: Array<{ operation: string; source: PortableLegacySource; input: unknown }> = [];
    const executor: LegacyAdapterExecutor = {
      async invokeLegacy<T>(_config: unknown, operation: 'legacy-owner-inspect-v1' | 'legacy-owner-export-v1', source: PortableLegacySource, input: unknown): Promise<T> {
        calls.push({ operation, source, input });
        if (operation === 'legacy-owner-inspect-v1') {
          return {
            installationId: config.installationId,
            baseIri: config.baseIri,
            packages,
            counts: { items: 0, properties: 0, statements: 0, resources: 0, annotations: 0, tasks: 0, memories: 0, prompts: 0, revisions: 0, payloads: 0 },
            payloadDigests: [],
            locked: false,
          } as T;
        }
        throw new Error('not used');
      },
      async readLegacy(_config: unknown, operation: 'legacy-taproot-payload-open-v1', source: PortableLegacySource, input: unknown) {
        calls.push({ operation, source, input });
        async function* stream() { yield Buffer.from('payload'); }
        return stream();
      },
    };
    const decoder = new OperatorLegacyDecoder(config, executor);
    await decoder.inspect(manifest);
    const chunks: Uint8Array[] = [];
    for await (const chunk of await decoder.openPayload(manifest, 'payload-1')) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('payload');
    expect(calls.map((call) => call.operation)).toEqual(['legacy-owner-inspect-v1', 'legacy-taproot-payload-open-v1']);
    expect(calls.every((call) => call.source.databasePath === databasePath)).toBe(true);
    const binding = calls[0]!.input as { format: string; legacyPackages: unknown; adapters: unknown };
    expect(binding.format).toBe('gnolith-legacy-owner-adapter-binding-v1');
    expect(canonicalJson(binding.legacyPackages)).toBe(canonicalJson(packages));
    expect(binding.adapters).toEqual(config.packages);

    await writeFile(`${databasePath}.maintenance.lock`, 'locked');
    await expect(preparePortableLegacySource(manifest, config)).rejects.toThrow(/locked/u);
  });
});

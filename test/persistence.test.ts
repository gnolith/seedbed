import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyNamespacedMigrations, checksumMigration, readAppliedMigrations } from '@gnolith/diamond';
import type { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { describe, expect, it } from 'vitest';
import type { KnowledgeService } from '@gnolith/workshop/protocol';
import {
  initializeDatabase,
  openDatabase,
  requireReady,
  type TaprootAssembly,
} from '../src/persistence.js';
import type { SeedbedConfig } from '../src/config.js';

const taprootMigration = { id: '0001-test-taproot', statements: ['CREATE TABLE taproot_test (id TEXT PRIMARY KEY) STRICT'] } as const;

function fakeTaproot(): TaprootAssembly {
  return {
    version: '0.2.0',
    migrate: (db) => applyNamespacedMigrations(db, '@gnolith/taproot', [taprootMigration]).then(() => undefined),
    async inspect(db) {
      const rows = await readAppliedMigrations(db, '@gnolith/taproot');
      const checksum = await checksumMigration(taprootMigration);
      return rows.length === 1 && rows[0]?.id === taprootMigration.id && rows[0].checksum === checksum
        ? { ready: true }
        : { ready: false, detail: 'Taproot test migration is pending or inconsistent' };
    },
    createKnowledgeService(): KnowledgeService {
      return { call: async () => ({}) };
    },
  };
}

async function fixtureConfig(): Promise<SeedbedConfig> {
  const directory = await mkdtemp(join(tmpdir(), 'seedbed-db-'));
  return {
    databasePath: join(directory, 'gnolith.sqlite'),
    baseIri: 'https://example.test/instance/',
    localOwnerId: 'owner',
    logLevel: 'silent',
    shutdownTimeoutMs: 1_000,
  };
}

describe('persistence coordinator', () => {
  it('initializes in component order and remains ready after reopen', async () => {
    const config = await fixtureConfig();
    const status = await initializeDatabase(config, fakeTaproot());
    expect(status.ready).toBe(true);
    expect(status.components.map(({ name }) => name)).toEqual(['diamond', 'taproot', 'workshop']);

    const reopened = await requireReady(config, fakeTaproot());
    await reopened.prepare("INSERT INTO taproot_test (id) VALUES ('persistent')").run();
    await reopened.close();
    const again = await requireReady(config, fakeTaproot());
    await expect(again.prepare("SELECT id FROM taproot_test WHERE id = 'persistent'").first()).resolves.toEqual({ id: 'persistent' });
    await again.close();
  });

  it('refuses pending state without advancing or mutating it', async () => {
    const config = await fixtureConfig();
    await initializeDatabase(config, fakeTaproot());
    const db = await openDatabase(config);
    await db.prepare("DELETE FROM _gnolith_migrations WHERE namespace = '@gnolith/workshop' AND migration_id = (SELECT MAX(migration_id) FROM _gnolith_migrations WHERE namespace = '@gnolith/workshop')").run();
    const before = await db.prepare("SELECT COUNT(*) AS count FROM _gnolith_migrations WHERE namespace = '@gnolith/workshop'").first<{ count: number }>();
    await db.close();

    await expect(requireReady(config, fakeTaproot())).rejects.toMatchObject({ code: 'persistence_not_ready' });
    const inspect = await openDatabase(config);
    const after = await inspect.prepare("SELECT COUNT(*) AS count FROM _gnolith_migrations WHERE namespace = '@gnolith/workshop'").first<{ count: number }>();
    expect(after).toEqual(before);
    await inspect.close();
  });

  it('binds the database to its stable base IRI', async () => {
    const config = await fixtureConfig();
    await initializeDatabase(config, fakeTaproot());
    await expect(requireReady({ ...config, baseIri: 'https://other.example/' }, fakeTaproot())).rejects.toMatchObject({ code: 'persistence_not_ready' });
  });

  it('fails closed on checksum drift and unknown newer migrations', async () => {
    const config = await fixtureConfig();
    await initializeDatabase(config, fakeTaproot());
    const db = await openDatabase(config);
    await db.prepare("UPDATE _gnolith_migrations SET checksum = 'drift' WHERE namespace = '@gnolith/diamond' AND migration_id = (SELECT MIN(migration_id) FROM _gnolith_migrations WHERE namespace = '@gnolith/diamond')").run();
    await db.close();
    await expect(requireReady(config, fakeTaproot())).rejects.toMatchObject({ code: 'persistence_not_ready' });

    const newerConfig = await fixtureConfig();
    await initializeDatabase(newerConfig, fakeTaproot());
    const newer = await openDatabase(newerConfig);
    await newer.prepare("INSERT INTO _gnolith_migrations (namespace, migration_id, checksum, adopted, applied_at) VALUES ('@gnolith/workshop', '9999-future', 'future', 0, '2026-01-01T00:00:00.000Z')").run();
    await newer.close();
    await expect(requireReady(newerConfig, fakeTaproot())).rejects.toMatchObject({ code: 'persistence_not_ready' });
  });
});

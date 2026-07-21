import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyNamespacedMigrations, checksumMigration, diamondMigrations, inspectStoreSchema, readAppliedMigrations } from '@gnolith/diamond';
import type { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { workshopMigrations } from '@gnolith/workshop/migrations';
import { describe, expect, it } from 'vitest';
import type { KnowledgeService } from '@gnolith/workshop/protocol';
import {
  initializeDatabase,
  migrateDatabase,
  migrateDatabaseWithPlan,
  openDatabase,
  requireReady,
  type ComponentMigrationPlan,
  type TaprootAssembly,
} from '../src/persistence.js';
import type { SeedbedConfig } from '../src/config.js';

const taprootMigration = { id: '0001-test-taproot', statements: ['CREATE TABLE taproot_test (id TEXT PRIMARY KEY) STRICT'] } as const;

function fakeTaproot(): TaprootAssembly {
  return fakeTaprootFor('0.2.0', [taprootMigration]);
}

function fakeTaprootFor(
  version: string,
  migrations: readonly { id: string; statements: readonly string[] }[],
): TaprootAssembly {
  return {
    version,
    migrate: (db) => applyNamespacedMigrations(db, '@gnolith/taproot', migrations).then(() => undefined),
    async inspect(db) {
      const rows = await readAppliedMigrations(db, '@gnolith/taproot');
      const checksums = await Promise.all(migrations.map(checksumMigration));
      return rows.length === migrations.length && rows.every((row, index) => (
        row.id === migrations[index]?.id && row.checksum === checksums[index]
      ))
        ? { ready: true }
        : { ready: false, detail: 'Taproot test migration is pending or inconsistent' };
    },
    createKnowledgeService(): KnowledgeService {
      return { call: async () => ({}) };
    },
  };
}

const currentVersions = {
  diamond: '0.4.0',
  taproot: '0.2.0',
  workshop: '0.2.3',
  seedbed: '0.1.1',
} as const;

const futureVersions = {
  diamond: '0.5.0-test',
  taproot: '0.3.0-test',
  workshop: '0.3.0-test',
  seedbed: '0.2.0-test',
} as const;

const futureDiamondMigration = {
  id: '9998-seedbed-fixture-diamond',
  statements: ['CREATE TABLE seedbed_fixture_diamond (id TEXT PRIMARY KEY) STRICT'],
} as const;
const futureTaprootMigration = {
  id: '9998-seedbed-fixture-taproot',
  statements: ['CREATE TABLE seedbed_fixture_taproot (id TEXT PRIMARY KEY) STRICT'],
} as const;
const futureWorkshopMigration = {
  id: '9998-seedbed-fixture-workshop',
  statements: ['CREATE TABLE seedbed_fixture_workshop (id TEXT PRIMARY KEY) STRICT'],
} as const;

const currentWorkshopMigrations = workshopMigrations.map(({ id, sql }) => ({
  id,
  statements: sql.split(/;\s*(?:\r?\n|$)/u).map((statement) => statement.trim()).filter(Boolean),
}));

function futurePlan(events: string[] = []): ComponentMigrationPlan {
  const diamond = [...diamondMigrations, futureDiamondMigration];
  const workshop = [...currentWorkshopMigrations, futureWorkshopMigration];
  return {
    target: { ...futureVersions },
    allowedPredecessors: [{
      versions: currentVersions,
      diamond: {
        migrations: diamondMigrations,
        async verify(db) {
          const inspection = await inspectStoreSchema(db);
          return inspection.valid ? { ready: true } : { ready: false, detail: inspection.errors.join('; ') };
        },
      },
      taproot: { verify: (db, baseIri) => fakeTaproot().inspect(db, baseIri) },
      workshop: {
        migrations: currentWorkshopMigrations,
        verify: verifyCurrentWorkshopFixture,
      },
    }],
    diamond: {
      migrations: diamond,
      async migrate(db) {
        events.push('migrate:diamond');
        await applyNamespacedMigrations(db, '@gnolith/diamond', diamond);
      },
      verify: (db) => fixtureTableReady(db, 'seedbed_fixture_diamond'),
    },
    workshop: {
      migrations: workshop,
      async migrate(db) {
        events.push('migrate:workshop');
        await applyNamespacedMigrations(db, '@gnolith/workshop', workshop);
      },
      verify: (db) => fixtureTableReady(db, 'seedbed_fixture_workshop'),
    },
  };
}

async function verifyCurrentWorkshopFixture(
  db: NodeSqliteDatabase,
): Promise<{ ready: boolean; detail?: string }> {
  const version = await db.prepare('SELECT version FROM workshop_schema WHERE singleton = 1')
    .first<{ version: number }>();
  return version?.version === 3
    ? { ready: true }
    : { ready: false, detail: 'Workshop fixture schema version is not current' };
}

async function fixtureTableReady(
  db: NodeSqliteDatabase,
  name: string,
): Promise<{ ready: boolean; detail?: string }> {
  const rows = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(name)
    .all<{ name: string }>();
  return rows.results[0]?.name === name ? { ready: true } : { ready: false, detail: `missing ${name}` };
}

function futureTaproot(events: string[] = []): TaprootAssembly {
  const base = fakeTaprootFor(futureVersions.taproot, [taprootMigration, futureTaprootMigration]);
  return {
    ...base,
    async migrate(db, baseIri) {
      events.push('migrate:taproot');
      await base.migrate(db, baseIri);
    },
  };
}

async function readMarker(config: SeedbedConfig): Promise<Record<string, string> | null> {
  const db = await openDatabase(config);
  try {
    return await db.prepare(`SELECT diamond_version, taproot_version, workshop_version, seedbed_version
      FROM seedbed_assembly WHERE singleton = 1`).first<Record<string, string>>();
  } finally {
    await db.close();
  }
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
    expect(status.components.map(({ name, version }) => ({ name, version }))).toEqual([
      { name: 'diamond', version: '0.4.0' },
      { name: 'taproot', version: '0.2.0' },
      { name: 'workshop', version: '0.2.3' },
    ]);

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

  it('does not report readiness when package schema is corrupt behind an intact ledger and marker', async () => {
    const config = await fixtureConfig();
    await initializeDatabase(config, fakeTaproot());
    const db = await openDatabase(config);
    await db.prepare('DROP TABLE rdf_quads').run();
    await db.close();

    await expect(requireReady(config, fakeTaproot())).rejects.toMatchObject({ code: 'persistence_not_ready' });
  });

  it('does not rewrite a newer assembly marker during migrate', async () => {
    const config = await fixtureConfig();
    await initializeDatabase(config, fakeTaproot());
    const db = await openDatabase(config);
    await db.prepare("UPDATE seedbed_assembly SET seedbed_version = '9.0.0' WHERE singleton = 1").run();
    await db.close();
    await expect(migrateDatabase(config, fakeTaproot())).rejects.toMatchObject({ code: 'assembly_version_mismatch' });
    const verify = await openDatabase(config);
    await expect(verify.prepare('SELECT seedbed_version FROM seedbed_assembly WHERE singleton = 1').first()).resolves.toEqual({ seedbed_version: '9.0.0' });
    await verify.close();
  });

  it('does not repair a missing marker in an otherwise initialized assembly', async () => {
    const config = await fixtureConfig();
    await initializeDatabase(config, fakeTaproot());
    const db = await openDatabase(config);
    await db.prepare('DELETE FROM seedbed_assembly WHERE singleton = 1').run();
    await db.close();
    await expect(migrateDatabase(config, fakeTaproot())).rejects.toMatchObject({ code: 'assembly_inconsistent' });
    const verify = await openDatabase(config);
    await expect(verify.prepare('SELECT COUNT(*) AS count FROM seedbed_assembly').first()).resolves.toEqual({ count: 0 });
    await verify.close();
  });

  it('does not repair a missing assembly table when its ledger is present', async () => {
    const config = await fixtureConfig();
    await initializeDatabase(config, fakeTaproot());
    const db = await openDatabase(config);
    await db.prepare('DROP TABLE seedbed_assembly').run();
    await db.close();
    await expect(migrateDatabase(config, fakeTaproot())).rejects.toMatchObject({ code: 'assembly_inconsistent' });
    const verify = await openDatabase(config);
    await expect(verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'seedbed_assembly'").first()).resolves.toBeNull();
    await verify.close();
  });

  it('does not overwrite a marker changed while component migration is paused', async () => {
    const config = await fixtureConfig();
    await initializeDatabase(config, fakeTaproot());
    let migrationStarted!: () => void;
    const started = new Promise<void>((resolve) => { migrationStarted = resolve; });
    let resumeMigration!: () => void;
    const resume = new Promise<void>((resolve) => { resumeMigration = resolve; });
    const base = fakeTaproot();
    const paused: TaprootAssembly = {
      ...base,
      async migrate(db, baseIri) {
        migrationStarted();
        await resume;
        await base.migrate(db, baseIri);
      },
    };
    const migrating = migrateDatabase(config, paused);
    await started;
    const concurrent = await openDatabase(config);
    await concurrent.prepare("UPDATE seedbed_assembly SET seedbed_version = '9.0.0' WHERE singleton = 1").run();
    await concurrent.close();
    resumeMigration();
    await expect(migrating).rejects.toMatchObject({ code: 'assembly_concurrent_change' });
    const verify = await openDatabase(config);
    await expect(verify.prepare('SELECT seedbed_version FROM seedbed_assembly WHERE singleton = 1').first()).resolves.toEqual({ seedbed_version: '9.0.0' });
    await verify.close();
  });

  it('advances only an explicit predecessor after ordered component migration and verification', async () => {
    const config = await fixtureConfig();
    await initializeDatabase(config, fakeTaproot());
    const events: string[] = [];
    const status = await migrateDatabaseWithPlan(config, futureTaproot(events), futurePlan(events), {
      afterComponent(component) { events.push(`verified:${component}`); },
    });

    expect(events).toEqual([
      'migrate:diamond', 'verified:diamond',
      'migrate:taproot', 'verified:taproot',
      'migrate:workshop', 'verified:workshop',
    ]);
    expect(status.ready).toBe(true);
    expect(await readMarker(config)).toEqual({
      diamond_version: futureVersions.diamond,
      taproot_version: futureVersions.taproot,
      workshop_version: futureVersions.workshop,
      seedbed_version: futureVersions.seedbed,
    });
  });

  it('snapshots the declared target before migration callbacks can mutate their source plan', async () => {
    const config = await fixtureConfig();
    await initializeDatabase(config, fakeTaproot());
    const plan = futurePlan();
    const status = await migrateDatabaseWithPlan(config, futureTaproot(), plan, {
      afterComponent(component) {
        if (component === 'diamond') {
          (plan.target as { seedbed: string }).seedbed = 'mutated-during-migration';
        }
      },
    });

    expect(status.ready).toBe(true);
    expect((await readMarker(config))?.seedbed_version).toBe(futureVersions.seedbed);
  });

  for (const boundary of ['diamond', 'taproot', 'workshop'] as const) {
    it(`recovers idempotently after interruption at the ${boundary} boundary`, async () => {
      const config = await fixtureConfig();
      await initializeDatabase(config, fakeTaproot());
      await expect(migrateDatabaseWithPlan(config, futureTaproot(), futurePlan(), {
        afterComponent(component) {
          if (component === boundary) throw new Error(`interrupt:${boundary}`);
        },
      })).rejects.toThrow(`interrupt:${boundary}`);

      expect(await readMarker(config)).toEqual({
        diamond_version: currentVersions.diamond,
        taproot_version: currentVersions.taproot,
        workshop_version: currentVersions.workshop,
        seedbed_version: currentVersions.seedbed,
      });

      const recovered = await migrateDatabaseWithPlan(config, futureTaproot(), futurePlan());
      expect(recovered.ready).toBe(true);
      const repeated = await migrateDatabaseWithPlan(config, futureTaproot(), futurePlan());
      expect(repeated.ready).toBe(true);
    });
  }

  it('rejects an unlisted predecessor before any component mutation', async () => {
    const config = await fixtureConfig();
    await initializeDatabase(config, fakeTaproot());
    const db = await openDatabase(config);
    await db.prepare("UPDATE seedbed_assembly SET seedbed_version = '0.0.9-unknown' WHERE singleton = 1").run();
    await db.close();
    const events: string[] = [];

    await expect(migrateDatabaseWithPlan(config, futureTaproot(events), futurePlan(events)))
      .rejects.toMatchObject({ code: 'assembly_version_mismatch' });
    expect(events).toEqual([]);
  });

  it('requires the exact loaded Taproot target before opening or mutating the database', async () => {
    const config = await fixtureConfig();
    await initializeDatabase(config, fakeTaproot());
    const events: string[] = [];
    await expect(migrateDatabaseWithPlan(config, fakeTaproot(), futurePlan(events)))
      .rejects.toMatchObject({ code: 'component_version_mismatch' });
    expect(events).toEqual([]);
    expect(await readMarker(config)).toEqual({
      diamond_version: currentVersions.diamond,
      taproot_version: currentVersions.taproot,
      workshop_version: currentVersions.workshop,
      seedbed_version: currentVersions.seedbed,
    });
  });

  it('does not advance the marker when a component fails exact target verification', async () => {
    const config = await fixtureConfig();
    await initializeDatabase(config, fakeTaproot());
    const plan = futurePlan();
    plan.diamond.verify = async () => ({ ready: false, detail: 'simulated target schema mismatch' });

    await expect(migrateDatabaseWithPlan(config, futureTaproot(), plan))
      .rejects.toThrow('simulated target schema mismatch');
    expect(await readMarker(config)).toEqual({
      diamond_version: currentVersions.diamond,
      taproot_version: currentVersions.taproot,
      workshop_version: currentVersions.workshop,
      seedbed_version: currentVersions.seedbed,
    });
  });

  it('preflights every predecessor component before mutating an earlier component', async () => {
    const config = await fixtureConfig();
    await initializeDatabase(config, fakeTaproot());
    const db = await openDatabase(config);
    await db.prepare("UPDATE _gnolith_migrations SET checksum = 'late-drift' WHERE namespace = '@gnolith/workshop' AND migration_id = (SELECT MAX(migration_id) FROM _gnolith_migrations WHERE namespace = '@gnolith/workshop')").run();
    await db.close();
    const events: string[] = [];

    await expect(migrateDatabaseWithPlan(config, futureTaproot(events), futurePlan(events)))
      .rejects.toThrow('Checksum drift detected');
    expect(events).toEqual([]);
    const verify = await openDatabase(config);
    await expect(verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'seedbed_fixture_diamond'").first()).resolves.toBeNull();
    await expect(verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'seedbed_fixture_taproot'").first()).resolves.toBeNull();
    await verify.close();
  });

  it('conditionally advances the marker under concurrent future migration', async () => {
    const config = await fixtureConfig();
    await initializeDatabase(config, fakeTaproot());
    let reachedBoundary!: () => void;
    const reached = new Promise<void>((resolve) => { reachedBoundary = resolve; });
    let resumeFirst!: () => void;
    const resume = new Promise<void>((resolve) => { resumeFirst = resolve; });
    const first = migrateDatabaseWithPlan(config, futureTaproot(), futurePlan(), {
      async afterComponent(component) {
        if (component === 'workshop') {
          reachedBoundary();
          await resume;
        }
      },
    });
    await reached;
    const second = await migrateDatabaseWithPlan(config, futureTaproot(), futurePlan());
    expect(second.ready).toBe(true);
    resumeFirst();
    await expect(first).resolves.toMatchObject({ ready: true });
    expect(await readMarker(config)).toEqual({
      diamond_version: futureVersions.diamond,
      taproot_version: futureVersions.taproot,
      workshop_version: futureVersions.workshop,
      seedbed_version: futureVersions.seedbed,
    });
  });

  it('rejects an ABA marker change even when the version tuple is restored', async () => {
    const config = await fixtureConfig();
    await initializeDatabase(config, fakeTaproot());
    let reachedBoundary!: () => void;
    const reached = new Promise<void>((resolve) => { reachedBoundary = resolve; });
    let resumeMigration!: () => void;
    const resume = new Promise<void>((resolve) => { resumeMigration = resolve; });
    const migrating = migrateDatabaseWithPlan(config, futureTaproot(), futurePlan(), {
      async afterComponent(component) {
        if (component === 'workshop') {
          reachedBoundary();
          await resume;
        }
      },
    });
    await reached;
    const concurrent = await openDatabase(config);
    await concurrent.prepare("UPDATE seedbed_assembly SET seedbed_version = 'temporary', updated_at = '2026-07-21T23:59:58.000Z' WHERE singleton = 1").run();
    await concurrent.prepare("UPDATE seedbed_assembly SET seedbed_version = '0.1.1', updated_at = '2026-07-21T23:59:59.000Z' WHERE singleton = 1").run();
    await concurrent.close();
    resumeMigration();

    await expect(migrating).rejects.toMatchObject({ code: 'assembly_concurrent_change' });
    expect(await readMarker(config)).toEqual({
      diamond_version: currentVersions.diamond,
      taproot_version: currentVersions.taproot,
      workshop_version: currentVersions.workshop,
      seedbed_version: currentVersions.seedbed,
    });
  });
});

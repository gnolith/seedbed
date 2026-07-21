import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  applyNamespacedMigrations,
  checksumMigration,
  diamondMigrations,
  migrateDiamondStore,
  readAppliedMigrations,
} from '@gnolith/diamond';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { applyWorkshopMigrations } from '@gnolith/workshop/migrations';
import { workshopMigrations } from '@gnolith/workshop/migrations';
import type { SeedbedConfig } from './config.js';
import { requireBaseIri } from './config.js';
import { ExitCode, SeedbedError } from './errors.js';
import type { KnowledgeService } from '@gnolith/workshop/protocol';
import type { WorkshopPersistence } from '@gnolith/workshop/core';

export const ASSEMBLY_NAMESPACE = '@gnolith/seedbed';
export const ASSEMBLY_ID = '0001-assembly-v1';

export interface ComponentStatus {
  name: 'diamond' | 'taproot' | 'workshop';
  version: string;
  ready: boolean;
  detail?: string;
}

export interface ReadinessStatus {
  ready: boolean;
  databasePath: string;
  baseIri?: string;
  assembly: 'missing' | 'ready' | 'inconsistent';
  components: ComponentStatus[];
}

export interface TaprootAssembly {
  readonly version: string;
  migrate(db: NodeSqliteDatabase, baseIri: string): Promise<void>;
  inspect(db: NodeSqliteDatabase, baseIri: string): Promise<{ ready: boolean; detail?: string }>;
  createKnowledgeService(db: NodeSqliteDatabase, baseIri: string): KnowledgeService;
}

export interface MigrationVersions {
  diamond: string;
  taproot: string;
  workshop: string;
  seedbed: string;
}

type AssemblyExpectation =
  | { kind: 'absent' }
  | { kind: 'current'; marker: AssemblyRow };

const versions: MigrationVersions = {
  diamond: '0.4.0',
  taproot: '0.2.0',
  workshop: '0.2.2',
  seedbed: '0.1.0',
};

export async function openDatabase(config: SeedbedConfig): Promise<NodeSqliteDatabase> {
  await mkdir(dirname(config.databasePath), { recursive: true });
  return new NodeSqliteDatabase(config.databasePath, { busyTimeoutMs: 5_000 });
}

export async function databaseExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function initializeDatabase(config: SeedbedConfig, taproot: TaprootAssembly): Promise<ReadinessStatus> {
  const baseIri = requireBaseIri(config);
  const normalizedConfig = { ...config, baseIri };
  if (await databaseExists(config.databasePath)) {
    throw new SeedbedError(
      `Refusing to initialize existing database ${config.databasePath}; use seedbed migrate`,
      ExitCode.persistence,
      'database_exists',
    );
  }
  const db = await openDatabase(config);
  try {
    await runMigrations(db, taproot, baseIri);
    await writeAssemblyMarker(db, baseIri, taproot.version);
    return await inspectReadiness(db, normalizedConfig, taproot);
  } catch (error) {
    throw persistenceError('Initialization failed', error);
  } finally {
    await db.close();
  }
}

export async function migrateDatabase(config: SeedbedConfig, taproot: TaprootAssembly): Promise<ReadinessStatus> {
  const baseIri = requireBaseIri(config);
  const normalizedConfig = { ...config, baseIri };
  if (!(await databaseExists(config.databasePath))) {
    throw new SeedbedError(
      `Database ${config.databasePath} does not exist; use seedbed init`,
      ExitCode.persistence,
      'database_missing',
    );
  }
  const db = await openDatabase(config);
  try {
    const expectation = await verifyAssemblyForMigration(db, baseIri, taproot.version);
    await runMigrations(db, taproot, baseIri);
    await writeAssemblyMarker(db, baseIri, taproot.version, expectation);
    return await inspectReadiness(db, normalizedConfig, taproot);
  } catch (error) {
    throw persistenceError('Migration failed', error);
  } finally {
    await db.close();
  }
}

async function runMigrations(db: NodeSqliteDatabase, taproot: TaprootAssembly, baseIri: string): Promise<void> {
  // This order is an externally visible safety invariant.
  await migrateDiamondStore(db);
  await taproot.migrate(db, baseIri);
  // NodeSqliteDatabase implements first() at runtime; Diamond's bind() return type
  // intentionally exposes only the smaller portable interface.
  await applyWorkshopMigrations(db as unknown as WorkshopPersistence);
}

export async function inspectReadiness(
  db: NodeSqliteDatabase,
  config: SeedbedConfig,
  taproot: TaprootAssembly,
): Promise<ReadinessStatus> {
  const components: ComponentStatus[] = [
    { name: 'diamond', version: versions.diamond, ready: false },
    { name: 'taproot', version: taproot.version, ready: false },
    { name: 'workshop', version: versions.workshop, ready: false },
  ];
  let assembly: ReadinessStatus['assembly'] = 'missing';
  try {
    await verifyNamespace(db, '@gnolith/diamond', diamondMigrations);
    components[0] = { ...components[0]!, ready: true };
    if (!config.baseIri) throw new Error('Configured base IRI is required for readiness');
    const taprootStatus = await taproot.inspect(db, config.baseIri);
    components[1] = { ...components[1]!, ...taprootStatus };
    const workshopKnown = workshopMigrations.map(({ id, sql }) => ({
      id,
      statements: sql.split(/;\s*(?:\r?\n|$)/u).map((statement) => statement.trim()).filter(Boolean),
    }));
    await verifyNamespace(db, '@gnolith/workshop', workshopKnown);
    components[2] = { ...components[2]!, ready: true };
    await verifyNamespace(db, ASSEMBLY_NAMESPACE, [{
      id: ASSEMBLY_ID,
      statements: [assemblyTableStatement],
    }]);
    const marker = await readAssemblyMarker(db);
    if (marker === null) {
      assembly = 'missing';
    } else if (
      marker.base_iri === config.baseIri &&
      marker.diamond_version === versions.diamond &&
      marker.taproot_version === taproot.version &&
      marker.workshop_version === versions.workshop &&
      marker.seedbed_version === versions.seedbed
    ) {
      assembly = 'ready';
    } else {
      assembly = 'inconsistent';
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ready: false, databasePath: config.databasePath, ...(config.baseIri ? { baseIri: config.baseIri } : {}), assembly: 'inconsistent', components: components.map((component) => ({ ...component, detail: component.detail ?? detail })) };
  }
  return {
    ready: assembly === 'ready' && components.every((component) => component.ready),
    databasePath: config.databasePath,
    ...(config.baseIri ? { baseIri: config.baseIri } : {}),
    assembly,
    components,
  };
}

export async function requireReady(config: SeedbedConfig, taproot: TaprootAssembly): Promise<NodeSqliteDatabase> {
  const baseIri = requireBaseIri(config);
  const normalizedConfig = { ...config, baseIri };
  if (!(await databaseExists(config.databasePath))) {
    throw new SeedbedError(
      `Database ${config.databasePath} does not exist; run seedbed init`,
      ExitCode.persistence,
      'database_missing',
    );
  }
  const db = await openDatabase(config);
  try {
    const status = await inspectReadiness(db, normalizedConfig, taproot);
    if (!status.ready) {
      throw new SeedbedError(
        'Persistence is not ready; inspect with seedbed doctor and advance only with seedbed migrate',
        ExitCode.persistence,
        'persistence_not_ready',
      );
    }
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

async function verifyNamespace(
  db: NodeSqliteDatabase,
  namespace: string,
  known: readonly { id: string; statements: readonly string[] }[],
): Promise<void> {
  const applied = await readAppliedMigrations(db, namespace);
  if (applied.length !== known.length) {
    throw new Error(`${namespace} has ${applied.length}/${known.length} migrations; explicit migration required`);
  }
  for (let index = 0; index < known.length; index += 1) {
    const expected = known[index]!;
    const actual = applied[index];
    if (!actual || actual.id !== expected.id) {
      throw new Error(`${namespace} migration ${actual?.id ?? '(missing)'} does not match expected predecessor ${expected.id}`);
    }
    if (actual.checksum !== await checksumMigration(expected)) {
      throw new Error(`Checksum drift detected for ${namespace}/${expected.id}`);
    }
  }
}

async function verifyAssemblyForMigration(db: NodeSqliteDatabase, baseIri: string, taprootVersion: string): Promise<AssemblyExpectation> {
  const assemblyTablePresent = await tableExists(db, 'seedbed_assembly');
  const ledgerPresent = await tableExists(db, '_gnolith_migrations');
  const assemblyMigrations = ledgerPresent ? await readAppliedMigrations(db, ASSEMBLY_NAMESPACE) : [];
  if (!assemblyTablePresent && assemblyMigrations.length === 0) return { kind: 'absent' };
  if (!assemblyTablePresent || assemblyMigrations.length === 0) {
    throw new SeedbedError(
      'Seedbed assembly table and migration ledger are only partially present; refusing repair',
      ExitCode.persistence,
      'assembly_inconsistent',
    );
  }
  await verifyNamespace(db, ASSEMBLY_NAMESPACE, [{ id: ASSEMBLY_ID, statements: [assemblyTableStatement] }]);
  const marker = await readAssemblyMarker(db);
  if (!marker) {
    throw new SeedbedError(
      'Seedbed assembly marker is missing from an initialized assembly; refusing repair',
      ExitCode.persistence,
      'assembly_inconsistent',
    );
  }
  if (marker.base_iri !== baseIri) {
    throw new SeedbedError(
      `Configured base IRI ${baseIri} does not match database identity ${marker.base_iri}`,
      ExitCode.persistence,
      'identity_mismatch',
    );
  }
  if (
    marker.diamond_version !== versions.diamond ||
    marker.taproot_version !== taprootVersion ||
    marker.workshop_version !== versions.workshop ||
    marker.seedbed_version !== versions.seedbed
  ) {
    throw new SeedbedError(
      'Assembly marker contains an unknown, newer, or inconsistent package set; refusing to rewrite it',
      ExitCode.persistence,
      'assembly_version_mismatch',
    );
  }
  return { kind: 'current', marker };
}

async function writeAssemblyMarker(
  db: NodeSqliteDatabase,
  baseIri: string,
  taprootVersion: string,
  expectation: AssemblyExpectation = { kind: 'absent' },
): Promise<void> {
  await applyNamespacedMigrations(db, ASSEMBLY_NAMESPACE, [{
    id: ASSEMBLY_ID,
    statements: [assemblyTableStatement],
  }]);
  const now = new Date().toISOString();
  const result = expectation.kind === 'absent'
    ? await db.prepare(`INSERT INTO seedbed_assembly (
        singleton, base_iri, diamond_version, taproot_version, workshop_version, seedbed_version, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO NOTHING`).bind(
        baseIri, versions.diamond, taprootVersion, versions.workshop, versions.seedbed, now,
      ).run()
    : await db.prepare(`UPDATE seedbed_assembly SET updated_at = ?
      WHERE singleton = 1
        AND base_iri = ?
        AND diamond_version = ?
        AND taproot_version = ?
        AND workshop_version = ?
        AND seedbed_version = ?`).bind(
        now,
        expectation.marker.base_iri,
        expectation.marker.diamond_version,
        expectation.marker.taproot_version,
        expectation.marker.workshop_version,
        expectation.marker.seedbed_version,
      ).run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new SeedbedError(
      'Assembly marker changed concurrently; refusing to overwrite it',
      ExitCode.persistence,
      'assembly_concurrent_change',
    );
  }
}

interface AssemblyRow {
  base_iri: string;
  diamond_version: string;
  taproot_version: string;
  workshop_version: string;
  seedbed_version: string;
}

const assemblyTableStatement = `CREATE TABLE seedbed_assembly (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    base_iri TEXT NOT NULL,
    diamond_version TEXT NOT NULL,
    taproot_version TEXT NOT NULL,
    workshop_version TEXT NOT NULL,
    seedbed_version TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`;

async function readAssemblyMarker(db: NodeSqliteDatabase): Promise<AssemblyRow | null> {
  if (!(await tableExists(db, 'seedbed_assembly'))) return null;
  return db.prepare('SELECT base_iri, diamond_version, taproot_version, workshop_version, seedbed_version FROM seedbed_assembly WHERE singleton = 1').first<AssemblyRow>();
}

async function tableExists(db: NodeSqliteDatabase, name: string): Promise<boolean> {
  const table = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").bind(name).all<{ name: string }>();
  return table.results.length === 1;
}

function persistenceError(prefix: string, error: unknown): SeedbedError {
  if (error instanceof SeedbedError) return error;
  return new SeedbedError(
    `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
    ExitCode.persistence,
    'persistence_failure',
    { cause: error },
  );
}

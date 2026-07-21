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
    return await inspectReadiness(db, config, taproot);
  } catch (error) {
    throw persistenceError('Initialization failed', error);
  } finally {
    await db.close();
  }
}

export async function migrateDatabase(config: SeedbedConfig, taproot: TaprootAssembly): Promise<ReadinessStatus> {
  requireBaseIri(config);
  if (!(await databaseExists(config.databasePath))) {
    throw new SeedbedError(
      `Database ${config.databasePath} does not exist; use seedbed init`,
      ExitCode.persistence,
      'database_missing',
    );
  }
  const db = await openDatabase(config);
  try {
    await verifyAssemblyIdentity(db, config.baseIri!);
    await runMigrations(db, taproot, config.baseIri!);
    await writeAssemblyMarker(db, config.baseIri!, taproot.version);
    return await inspectReadiness(db, config, taproot);
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
  if (!(await databaseExists(config.databasePath))) {
    throw new SeedbedError(
      `Database ${config.databasePath} does not exist; run seedbed init`,
      ExitCode.persistence,
      'database_missing',
    );
  }
  const db = await openDatabase(config);
  try {
    const status = await inspectReadiness(db, config, taproot);
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

async function verifyAssemblyIdentity(db: NodeSqliteDatabase, baseIri: string): Promise<void> {
  const marker = await readAssemblyMarker(db);
  if (marker && marker.base_iri !== baseIri) {
    throw new SeedbedError(
      `Configured base IRI ${baseIri} does not match database identity ${marker.base_iri}`,
      ExitCode.persistence,
      'identity_mismatch',
    );
  }
}

async function writeAssemblyMarker(db: NodeSqliteDatabase, baseIri: string, taprootVersion: string): Promise<void> {
  await applyNamespacedMigrations(db, ASSEMBLY_NAMESPACE, [{
    id: ASSEMBLY_ID,
    statements: [assemblyTableStatement],
  }]);
  await db.prepare(`INSERT INTO seedbed_assembly (
    singleton, base_iri, diamond_version, taproot_version, workshop_version, seedbed_version, updated_at
  ) VALUES (1, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(singleton) DO UPDATE SET
    diamond_version = excluded.diamond_version,
    taproot_version = excluded.taproot_version,
    workshop_version = excluded.workshop_version,
    seedbed_version = excluded.seedbed_version,
    updated_at = excluded.updated_at`).bind(
      baseIri,
      versions.diamond,
      taprootVersion,
      versions.workshop,
      versions.seedbed,
      new Date().toISOString(),
    ).run();
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
  const table = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'seedbed_assembly'").first<{ name: string }>();
  if (!table) return null;
  return db.prepare('SELECT base_iri, diamond_version, taproot_version, workshop_version, seedbed_version FROM seedbed_assembly WHERE singleton = 1').first<AssemblyRow>();
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

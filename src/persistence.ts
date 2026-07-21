import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  applyNamespacedMigrations,
  checksumMigration,
  diamondMigrations,
  inspectStoreSchema,
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
  | { kind: 'markerless' }
  | { kind: 'existing'; marker: AssemblyRow; source: 'target' | AssemblyPredecessor };

export interface ComponentStatePlan {
  readonly migrations: readonly { id: string; statements: readonly string[] }[];
  verify(db: NodeSqliteDatabase): Promise<{ ready: boolean; detail?: string }>;
}

export interface AssemblyPredecessor {
  readonly versions: MigrationVersions;
  readonly diamond: ComponentStatePlan;
  readonly taproot: {
    verify(db: NodeSqliteDatabase, baseIri: string): Promise<{ ready: boolean; detail?: string }>;
  };
  readonly workshop: ComponentStatePlan;
}

export interface ComponentMigrationPlan {
  readonly target: MigrationVersions;
  readonly allowedPredecessors: readonly AssemblyPredecessor[];
  readonly diamond: ComponentStatePlan & {
    migrate(db: NodeSqliteDatabase): Promise<void>;
  };
  readonly workshop: ComponentStatePlan & {
    migrate(db: NodeSqliteDatabase): Promise<void>;
  };
}

export type MigrationBoundary = 'diamond' | 'taproot' | 'workshop';

export interface MigrationTestHooks {
  /** Test-only deterministic interruption point after a component is verified current. */
  afterComponent?(component: MigrationBoundary): void | Promise<void>;
}

const versions: MigrationVersions = {
  diamond: '0.4.0',
  taproot: '0.2.0',
  workshop: '0.2.3',
  seedbed: '0.1.1',
};

const workshopKnownMigrations = workshopMigrations.map(({ id, sql }) => ({
  id,
  statements: sql.split(/;\s*(?:\r?\n|$)/u).map((statement) => statement.trim()).filter(Boolean),
}));

const currentMigrationPlan: ComponentMigrationPlan = {
  target: versions,
  // A future Seedbed release must add each exact released predecessor and its
  // read-only package-owned verifiers here. Unknown package sets remain
  // fail-closed rather than being inferred from semver.
  allowedPredecessors: [],
  diamond: {
    migrations: diamondMigrations,
    migrate: migrateDiamondStore,
    async verify(db) {
      const inspection = await inspectStoreSchema(db);
      return inspection.valid
        ? { ready: true }
        : { ready: false, detail: inspection.errors.join('; ') };
    },
  },
  workshop: {
    migrations: workshopKnownMigrations,
    async migrate(db) {
      await applyWorkshopMigrations(db as unknown as WorkshopPersistence);
    },
    verify: verifyCurrentWorkshopSchema,
  },
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
  assertTaprootVersion(taproot, currentMigrationPlan);
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
    await runMigrations(db, taproot, baseIri, currentMigrationPlan);
    await writeAssemblyMarker(db, baseIri, currentMigrationPlan.target);
    return await inspectReadiness(db, normalizedConfig, taproot);
  } catch (error) {
    throw persistenceError('Initialization failed', error);
  } finally {
    await db.close();
  }
}

export async function migrateDatabase(config: SeedbedConfig, taproot: TaprootAssembly): Promise<ReadinessStatus> {
  return migrateDatabaseWithPlan(config, taproot, currentMigrationPlan);
}

/** Internal coordinator seam used to qualify future exact package assemblies before release. */
export async function migrateDatabaseWithPlan(
  config: SeedbedConfig,
  taproot: TaprootAssembly,
  plan: ComponentMigrationPlan,
  hooks: MigrationTestHooks = {},
): Promise<ReadinessStatus> {
  const stablePlan = snapshotMigrationPlan(plan);
  assertTaprootVersion(taproot, stablePlan);
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
    const expectation = await verifyAssemblyForMigration(db, baseIri, stablePlan);
    await preflightAssembly(db, baseIri, taproot, stablePlan, expectation);
    await runMigrations(db, taproot, baseIri, stablePlan, hooks);
    await writeAssemblyMarker(db, baseIri, stablePlan.target, expectation);
    return await inspectReadinessWithPlan(db, normalizedConfig, taproot, stablePlan);
  } catch (error) {
    throw persistenceError('Migration failed', error);
  } finally {
    await db.close();
  }
}

async function runMigrations(
  db: NodeSqliteDatabase,
  taproot: TaprootAssembly,
  baseIri: string,
  plan: ComponentMigrationPlan,
  hooks: MigrationTestHooks = {},
): Promise<void> {
  // This order is an externally visible safety invariant.
  await plan.diamond.migrate(db);
  await verifyNamespace(db, '@gnolith/diamond', plan.diamond.migrations);
  await requireComponentVerification('Diamond', await plan.diamond.verify(db));
  await hooks.afterComponent?.('diamond');
  await taproot.migrate(db, baseIri);
  const taprootStatus = await taproot.inspect(db, baseIri);
  if (!taprootStatus.ready) {
    throw new Error(taprootStatus.detail ?? 'Taproot migration did not produce the exact target schema');
  }
  await hooks.afterComponent?.('taproot');
  await plan.workshop.migrate(db);
  await verifyNamespace(db, '@gnolith/workshop', plan.workshop.migrations);
  await requireComponentVerification('Workshop', await plan.workshop.verify(db));
  await hooks.afterComponent?.('workshop');
}

export async function inspectReadiness(
  db: NodeSqliteDatabase,
  config: SeedbedConfig,
  taproot: TaprootAssembly,
): Promise<ReadinessStatus> {
  return inspectReadinessWithPlan(db, config, taproot, currentMigrationPlan);
}

async function inspectReadinessWithPlan(
  db: NodeSqliteDatabase,
  config: SeedbedConfig,
  taproot: TaprootAssembly,
  plan: ComponentMigrationPlan,
): Promise<ReadinessStatus> {
  const components: ComponentStatus[] = [
    { name: 'diamond', version: plan.target.diamond, ready: false },
    { name: 'taproot', version: taproot.version, ready: false },
    { name: 'workshop', version: plan.target.workshop, ready: false },
  ];
  let assembly: ReadinessStatus['assembly'] = 'missing';
  try {
    await verifyNamespace(db, '@gnolith/diamond', plan.diamond.migrations);
    await requireComponentVerification('Diamond', await plan.diamond.verify(db));
    components[0] = { ...components[0]!, ready: true };
    if (!config.baseIri) throw new Error('Configured base IRI is required for readiness');
    const taprootStatus = await taproot.inspect(db, config.baseIri);
    components[1] = { ...components[1]!, ...taprootStatus };
    await verifyNamespace(db, '@gnolith/workshop', plan.workshop.migrations);
    await requireComponentVerification('Workshop', await plan.workshop.verify(db));
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
      marker.diamond_version === plan.target.diamond &&
      marker.taproot_version === taproot.version &&
      marker.workshop_version === plan.target.workshop &&
      marker.seedbed_version === plan.target.seedbed
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

async function verifyAssemblyForMigration(
  db: NodeSqliteDatabase,
  baseIri: string,
  plan: ComponentMigrationPlan,
): Promise<AssemblyExpectation> {
  const assemblyTablePresent = await tableExists(db, 'seedbed_assembly');
  const ledgerPresent = await tableExists(db, '_gnolith_migrations');
  const assemblyMigrations = ledgerPresent ? await readAppliedMigrations(db, ASSEMBLY_NAMESPACE) : [];
  if (!assemblyTablePresent && assemblyMigrations.length === 0) return { kind: 'markerless' };
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
  const markerVersions = versionsFromMarker(marker);
  if (sameVersions(markerVersions, plan.target)) {
    return { kind: 'existing', marker, source: 'target' };
  }
  const predecessor = plan.allowedPredecessors.find((candidate) => sameVersions(markerVersions, candidate.versions));
  if (!predecessor) {
    throw new SeedbedError(
      'Assembly marker contains an unknown, newer, or inconsistent package set; refusing to rewrite it',
      ExitCode.persistence,
      'assembly_version_mismatch',
    );
  }
  return { kind: 'existing', marker, source: predecessor };
}

async function preflightAssembly(
  db: NodeSqliteDatabase,
  baseIri: string,
  taproot: TaprootAssembly,
  plan: ComponentMigrationPlan,
  expectation: AssemblyExpectation,
): Promise<void> {
  if (expectation.kind === 'absent') return;
  if (expectation.kind === 'markerless') {
    if (await isPristineDatabase(db)) return;
    const failures: string[] = [];
    for (const predecessor of plan.allowedPredecessors) {
      const failure = await captureVerification(async () => {
        await verifyComponentState(db, 'Diamond', '@gnolith/diamond', predecessor.diamond);
        await requireComponentVerification('Taproot', await predecessor.taproot.verify(db, baseIri));
        await verifyComponentState(db, 'Workshop', '@gnolith/workshop', predecessor.workshop);
      });
      if (!failure) return;
      failures.push(failure);
    }
    throw new SeedbedError(
      `Markerless database is not pristine or an exact explicit predecessor; refusing migration${failures.length > 0 ? ` (${failures.join(' | ')})` : ''}`,
      ExitCode.persistence,
      'assembly_inconsistent',
    );
  }
  const targetTaproot = { verify: (database: NodeSqliteDatabase, iri: string) => taproot.inspect(database, iri) };
  if (expectation.source === 'target') {
    await verifyComponentState(db, 'Diamond', '@gnolith/diamond', plan.diamond);
    await requireComponentVerification('Taproot', await targetTaproot.verify(db, baseIri));
    await verifyComponentState(db, 'Workshop', '@gnolith/workshop', plan.workshop);
    return;
  }
  // An interrupted explicit transition may leave any component at either the
  // predecessor or target state while the marker honestly remains predecessor.
  // No third state is accepted, and every component is checked before writes.
  await verifyOneOfComponentStates(db, 'Diamond', '@gnolith/diamond', expectation.source.diamond, plan.diamond);
  await verifyOneOfTaprootStates(db, baseIri, expectation.source.taproot, targetTaproot);
  await verifyOneOfComponentStates(db, 'Workshop', '@gnolith/workshop', expectation.source.workshop, plan.workshop);
}

async function isPristineDatabase(db: NodeSqliteDatabase): Promise<boolean> {
  const objects = await db.prepare(`SELECT name FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger', 'view')
      AND name NOT LIKE 'sqlite_%'
    LIMIT 1`).all<{ name: string }>();
  return objects.results.length === 0;
}

async function verifyComponentState(
  db: NodeSqliteDatabase,
  name: string,
  namespace: string,
  state: ComponentStatePlan,
): Promise<void> {
  await verifyNamespace(db, namespace, state.migrations);
  await requireComponentVerification(name, await state.verify(db));
}

async function verifyOneOfComponentStates(
  db: NodeSqliteDatabase,
  name: string,
  namespace: string,
  predecessor: ComponentStatePlan,
  target: ComponentStatePlan,
): Promise<void> {
  const predecessorError = await captureVerification(() => verifyComponentState(db, name, namespace, predecessor));
  if (!predecessorError) return;
  const targetError = await captureVerification(() => verifyComponentState(db, name, namespace, target));
  if (!targetError) return;
  throw new Error(`${name} is neither the exact predecessor nor target state (${predecessorError}; ${targetError})`);
}

async function verifyOneOfTaprootStates(
  db: NodeSqliteDatabase,
  baseIri: string,
  predecessor: AssemblyPredecessor['taproot'],
  target: AssemblyPredecessor['taproot'],
): Promise<void> {
  const inspect = async (state: AssemblyPredecessor['taproot']): Promise<string | null> => {
    try {
      const status = await state.verify(db, baseIri);
      return status.ready ? null : (status.detail ?? 'schema rejected');
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  const predecessorError = await inspect(predecessor);
  if (!predecessorError) return;
  const targetError = await inspect(target);
  if (!targetError) return;
  throw new Error(`Taproot is neither the exact predecessor nor target state (${predecessorError}; ${targetError})`);
}

async function captureVerification(operation: () => Promise<void>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function writeAssemblyMarker(
  db: NodeSqliteDatabase,
  baseIri: string,
  target: MigrationVersions,
  expectation: AssemblyExpectation = { kind: 'absent' },
): Promise<void> {
  await applyNamespacedMigrations(db, ASSEMBLY_NAMESPACE, [{
    id: ASSEMBLY_ID,
    statements: [assemblyTableStatement],
  }]);
  const now = new Date().toISOString();
  const result = expectation.kind !== 'existing'
    ? await db.prepare(`INSERT INTO seedbed_assembly (
        singleton, base_iri, diamond_version, taproot_version, workshop_version, seedbed_version, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO NOTHING`).bind(
        baseIri, target.diamond, target.taproot, target.workshop, target.seedbed, now,
      ).run()
    : await db.prepare(`UPDATE seedbed_assembly SET
        diamond_version = ?, taproot_version = ?, workshop_version = ?, seedbed_version = ?, updated_at = ?
      WHERE singleton = 1
        AND base_iri = ?
        AND diamond_version = ?
        AND taproot_version = ?
        AND workshop_version = ?
        AND seedbed_version = ?
        AND updated_at = ?`).bind(
        target.diamond,
        target.taproot,
        target.workshop,
        target.seedbed,
        now,
        expectation.marker.base_iri,
        expectation.marker.diamond_version,
        expectation.marker.taproot_version,
        expectation.marker.workshop_version,
        expectation.marker.seedbed_version,
        expectation.marker.updated_at,
      ).run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    const winner = await readAssemblyMarker(db);
    if (winner?.base_iri === baseIri && sameVersions(versionsFromMarker(winner), target)) {
      return;
    }
    throw new SeedbedError(
      'Assembly marker changed concurrently; refusing to overwrite it',
      ExitCode.persistence,
      'assembly_concurrent_change',
    );
  }
}

function versionsFromMarker(marker: AssemblyRow): MigrationVersions {
  return {
    diamond: marker.diamond_version,
    taproot: marker.taproot_version,
    workshop: marker.workshop_version,
    seedbed: marker.seedbed_version,
  };
}

function sameVersions(left: MigrationVersions, right: MigrationVersions): boolean {
  return left.diamond === right.diamond
    && left.taproot === right.taproot
    && left.workshop === right.workshop
    && left.seedbed === right.seedbed;
}

function assertTaprootVersion(taproot: TaprootAssembly, plan: ComponentMigrationPlan): void {
  if (taproot.version !== plan.target.taproot) {
    throw new SeedbedError(
      `Loaded Taproot ${taproot.version} does not match exact assembly target ${plan.target.taproot}`,
      ExitCode.persistence,
      'component_version_mismatch',
    );
  }
}

function snapshotMigrationPlan(plan: ComponentMigrationPlan): ComponentMigrationPlan {
  const cloneState = (state: ComponentStatePlan): ComponentStatePlan => ({
    migrations: state.migrations.map((migration) => ({
      id: migration.id,
      statements: [...migration.statements],
    })),
    verify: state.verify,
  });
  return {
    target: { ...plan.target },
    allowedPredecessors: plan.allowedPredecessors.map((predecessor) => ({
      versions: { ...predecessor.versions },
      diamond: cloneState(predecessor.diamond),
      taproot: { verify: predecessor.taproot.verify },
      workshop: cloneState(predecessor.workshop),
    })),
    diamond: { ...cloneState(plan.diamond), migrate: plan.diamond.migrate },
    workshop: { ...cloneState(plan.workshop), migrate: plan.workshop.migrate },
  };
}

function requireComponentVerification(
  name: string,
  status: { ready: boolean; detail?: string },
): void {
  if (!status.ready) {
    throw new Error(status.detail ?? `${name} migration did not produce the exact target schema`);
  }
}

export async function verifyCurrentWorkshopSchema(
  db: NodeSqliteDatabase,
): Promise<{ ready: boolean; detail?: string }> {
  const [actual, canonical] = await Promise.all([
    captureWorkshopSchema(db),
    canonicalWorkshopSchema(),
  ]);
  return actual === canonical
    ? { ready: true }
    : { ready: false, detail: describeSchemaDifference(actual, canonical) };
}

function describeSchemaDifference(actual: string, canonical: string): string {
  let index = 0;
  while (index < actual.length && index < canonical.length && actual[index] === canonical[index]) index += 1;
  const start = Math.max(0, index - 80);
  return `Workshop schema differs from the canonical target near offset ${index}; actual=${actual.slice(start, index + 160)} expected=${canonical.slice(start, index + 160)}`;
}

let canonicalWorkshopSchemaPromise: Promise<string> | undefined;

function canonicalWorkshopSchema(): Promise<string> {
  canonicalWorkshopSchemaPromise ??= (async () => {
    const reference = new NodeSqliteDatabase(':memory:');
    try {
      await applyWorkshopMigrations(reference as unknown as WorkshopPersistence);
      return await captureWorkshopSchema(reference);
    } finally {
      await reference.close();
    }
  })();
  return canonicalWorkshopSchemaPromise;
}

interface SqliteMasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

async function captureWorkshopSchema(db: NodeSqliteDatabase): Promise<string> {
  const master = await db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger', 'view')
      AND (name GLOB 'workshop_*' OR tbl_name GLOB 'workshop_*'
        OR (type IN ('trigger', 'view') AND instr(lower(coalesce(sql, '')), 'workshop_') > 0))
    ORDER BY type, name`).all<SqliteMasterRow>();
  const objects = master.results.map((row) => ({
    type: row.type,
    name: row.name,
    table: row.tbl_name,
    sql: normalizeSchemaSql(row.sql),
  }));
  const tables: Record<string, unknown> = {};
  for (const table of master.results.filter(({ type, name }) => type === 'table' && name.startsWith('workshop_'))) {
    const identifier = quoteSqliteIdentifier(table.name);
    const columns = await db.prepare(`PRAGMA table_xinfo(${identifier})`).all<Record<string, unknown>>();
    const foreignKeys = await db.prepare(`PRAGMA foreign_key_list(${identifier})`).all<Record<string, unknown>>();
    const indexList = await db.prepare(`PRAGMA index_list(${identifier})`).all<Record<string, unknown>>();
    const indexes: Record<string, unknown> = {};
    for (const index of indexList.results) {
      const name = String(index.name);
      const details = await db.prepare(`PRAGMA index_xinfo(${quoteSqliteIdentifier(name)})`).all<Record<string, unknown>>();
      indexes[name] = details.results.map(normalizePragmaRow);
    }
    tables[table.name] = {
      columns: columns.results.map(normalizePragmaRow),
      foreignKeys: foreignKeys.results.map(normalizePragmaRow),
      indexList: indexList.results.map(normalizePragmaRow),
      indexes,
    };
  }
  const metadata = await db.prepare(`SELECT singleton, version, package_version
    FROM workshop_schema ORDER BY singleton`).all<Record<string, unknown>>();
  return JSON.stringify({ objects, tables, metadata: metadata.results.map(normalizePragmaRow) });
}

function normalizePragmaRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value ?? null]));
}

function normalizeSchemaSql(sql: string | null): string | null {
  return sql?.replace(/\s+/gu, ' ').trim() ?? null;
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/gu, '""')}"`;
}

interface AssemblyRow {
  base_iri: string;
  diamond_version: string;
  taproot_version: string;
  workshop_version: string;
  seedbed_version: string;
  updated_at: string;
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
  return db.prepare('SELECT base_iri, diamond_version, taproot_version, workshop_version, seedbed_version, updated_at FROM seedbed_assembly WHERE singleton = 1').first<AssemblyRow>();
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

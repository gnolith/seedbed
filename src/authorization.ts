import { randomBytes, randomUUID, subtle, timingSafeEqual, type webcrypto } from 'node:crypto';
import type { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import {
  bootstrapTaprootAuthorization,
  createInstallationAuthorizationGuard,
  createInstallationDomainMutationGuard,
  createTaprootHostWriteCapability,
  createAuthorizationCursorCodec,
  createAuthorizedTaproot,
  type AuthorizationContext,
  type InstallationAuthorizationGuard,
  type InstallationDomainMutationGuard,
  type TaprootHostWriteCapability,
  AuthorizationDeniedError,
  InvalidAuthorizationError,
} from '@gnolith/taproot';
import type {
  WorkshopAuthorizationAuthority,
  WorkshopCursorCodec,
  WorkshopPersistence,
  D1PreparedStatementLike,
} from '@gnolith/workshop/server';
import { WorkshopError } from '@gnolith/workshop/protocol';
import type { SeedbedConfig } from './config.js';
import { requireBaseIri } from './config.js';
import { ExitCode, SeedbedError } from './errors.js';
import { deriveInstallationKeys, type InstallationKeys } from './secrets.js';

export const EXACT_CAPABILITIES = ['read', 'task-write', 'knowledge-write', 'knowledge:write', 'knowledge:policy', 'memory-write', 'prompt-write', 'admin', 'search:admin'] as const;
export type ExactCapability = typeof EXACT_CAPABILITIES[number];

export const seedbedAuthorizationMigration = {
  id: '0002-installation-authorization-v1',
  statements: [
    `CREATE TABLE seedbed_installation (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      installation_id TEXT NOT NULL UNIQUE,
      base_iri TEXT NOT NULL,
      binding_tag TEXT NOT NULL,
      cursor_key_generation INTEGER NOT NULL CHECK (cursor_key_generation >= 1),
      created_at TEXT NOT NULL
    ) STRICT`,
    `CREATE TRIGGER seedbed_installation_no_update BEFORE UPDATE ON seedbed_installation
      BEGIN SELECT RAISE(ABORT, 'seedbed installation binding is immutable'); END`,
    `CREATE TRIGGER seedbed_installation_no_delete BEFORE DELETE ON seedbed_installation
      BEGIN SELECT RAISE(ABORT, 'seedbed installation binding is durable'); END`,
    `CREATE TABLE seedbed_principals (
      installation_id TEXT NOT NULL,
      selector TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (installation_id, selector),
      FOREIGN KEY (installation_id) REFERENCES seedbed_installation(installation_id)
    ) STRICT`,
    `CREATE TABLE seedbed_workspaces (
      installation_id TEXT NOT NULL,
      selector TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (installation_id, selector),
      FOREIGN KEY (installation_id) REFERENCES seedbed_installation(installation_id)
    ) STRICT`,
    `CREATE TABLE seedbed_workspace_memberships (
      installation_id TEXT NOT NULL,
      principal_selector TEXT NOT NULL,
      workspace_selector TEXT NOT NULL,
      PRIMARY KEY (installation_id, principal_selector, workspace_selector),
      FOREIGN KEY (installation_id, principal_selector) REFERENCES seedbed_principals(installation_id, selector),
      FOREIGN KEY (installation_id, workspace_selector) REFERENCES seedbed_workspaces(installation_id, selector)
    ) STRICT`,
    `CREATE TABLE seedbed_capability_grants (
      installation_id TEXT NOT NULL,
      principal_selector TEXT NOT NULL,
      capability TEXT NOT NULL CHECK (capability IN ('read','task-write','knowledge-write','knowledge:write','knowledge:policy','memory-write','admin','search:admin')),
      PRIMARY KEY (installation_id, principal_selector, capability),
      FOREIGN KEY (installation_id, principal_selector) REFERENCES seedbed_principals(installation_id, selector)
    ) STRICT`,
    `CREATE TABLE seedbed_authorization_audit (
      audit_id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL,
      principal_selector TEXT NOT NULL,
      action TEXT NOT NULL,
      details_json TEXT NOT NULL CHECK (json_valid(details_json)),
      created_at TEXT NOT NULL
    ) STRICT`,
    `CREATE TRIGGER seedbed_authorization_audit_no_update BEFORE UPDATE ON seedbed_authorization_audit
      BEGIN SELECT RAISE(ABORT, 'seedbed authorization audit is immutable'); END`,
    `CREATE TRIGGER seedbed_authorization_audit_no_delete BEFORE DELETE ON seedbed_authorization_audit
      BEGIN SELECT RAISE(ABORT, 'seedbed authorization audit is immutable'); END`,
  ],
} as const;

export const seedbedPromptAuthorizationMigration = {
  id: '0003-prompt-authorization-v1',
  statements: [
    `CREATE TABLE seedbed_capability_grants_v2 (
      installation_id TEXT NOT NULL,
      principal_selector TEXT NOT NULL,
      capability TEXT NOT NULL CHECK (capability IN ('read','task-write','knowledge-write','knowledge:write','knowledge:policy','memory-write','prompt-write','admin','search:admin')),
      PRIMARY KEY (installation_id, principal_selector, capability),
      FOREIGN KEY (installation_id, principal_selector) REFERENCES seedbed_principals(installation_id, selector)
    ) STRICT`,
    `INSERT INTO seedbed_capability_grants_v2 (installation_id, principal_selector, capability)
      SELECT installation_id, principal_selector, capability FROM seedbed_capability_grants`,
    'DROP TABLE seedbed_capability_grants',
    'ALTER TABLE seedbed_capability_grants_v2 RENAME TO seedbed_capability_grants',
    `INSERT INTO seedbed_capability_grants (installation_id, principal_selector, capability)
      SELECT installation_id, principal_selector, 'prompt-write'
      FROM seedbed_capability_grants
      GROUP BY installation_id, principal_selector
      HAVING COUNT(*) = 8`,
  ],
} as const;

interface InstallationRow { installation_id: string; base_iri: string; binding_tag: string; cursor_key_generation: number }
interface TaggedStatement extends D1PreparedStatementLike {
  readonly __seedbedSql: string;
  readonly __seedbedValues: readonly unknown[];
  readonly __seedbedUnderlying: D1PreparedStatementLike;
}

export interface SeedbedAuthorityBundle {
  readonly installationId: string;
  readonly authority: WorkshopAuthorizationAuthority;
  readonly persistence: WorkshopPersistence;
  readonly cursorCodec: WorkshopCursorCodec;
  readonly authorizationGuard: InstallationAuthorizationGuard;
  readonly hostCapability: TaprootHostWriteCapability;
  authorizedReader(context: AuthorizationContext): ReturnType<typeof createAuthorizedTaproot>;
  resolveContext(principalSelector: string, workspaceSelector?: string): Promise<AuthorizationContext>;
  resolveSearchAdminContext(): Promise<AuthorizationContext>;
}

export async function bootstrapAuthorization(
  db: NodeSqliteDatabase,
  config: SeedbedConfig,
  principalSelector: string,
  workspaceSelector: string,
): Promise<AuthorizationContext> {
  validateSelector(principalSelector);
  validateSelector(workspaceSelector);
  const baseIri = requireBaseIri(config);
  let installation = await readInstallation(db);
  if (!installation) {
    const installationId = randomUUID();
    const keys = await deriveInstallationKeys(config, installationId);
    const bindingTag = await installationBinding(keys.binding, installationId, baseIri);
    try {
      await db.prepare(`INSERT INTO seedbed_installation
        (singleton, installation_id, base_iri, binding_tag, cursor_key_generation, created_at)
        VALUES (1, ?, ?, ?, 1, ?)`).bind(installationId, baseIri, bindingTag, new Date().toISOString()).run();
    } catch {
      // A concurrent bootstrap may have established the singleton. Its binding
      // is verified below before any authority is issued.
    }
    installation = await readInstallation(db);
  }
  if (!installation) throw authorizationError('Installation binding was not persisted');
  const keys = await deriveInstallationKeys(config, installation.installation_id);
  const expectedBinding = await installationBinding(keys.binding, installation.installation_id, baseIri);
  if (!sameTag(expectedBinding, installation.binding_tag)) throw authorizationError('Root secret does not match this installation');
  const capability = createTaprootHostWriteCapability(db, { baseIri }, keys.hostWrite);
  try {
    const existingGuard = await createInstallationAuthorizationGuard(db, { baseIri }, capability);
    await existingGuard.readCurrentState();
  } catch {
    try {
      await bootstrapTaprootAuthorization(db, { baseIri }, capability, installation.installation_id);
    } catch (error) {
      try {
        const winner = await createInstallationAuthorizationGuard(db, { baseIri }, capability);
        await winner.readCurrentState();
      } catch {
        throw error;
      }
    }
  }
  const bundle = await createAuthorityBundle(db, config, installation);
  const principalCountStatement = db.prepare(`SELECT COUNT(*) AS count FROM seedbed_principals WHERE installation_id = ?`)
    .bind(installation.installation_id) as D1PreparedStatementLike;
  const principalCount = await principalCountStatement.first<{ count: number }>();
  if (Number(principalCount?.count ?? 0) > 0) {
    try {
      const existing = await bundle.resolveContext(principalSelector, workspaceSelector);
      if (sameExactSet(existing.workspaceIds, [workspaceSelector])
        && sameExactSet(existing.capabilities, EXACT_CAPABILITIES)) return existing;
    } catch {
      // Converted below to the non-oracular bootstrap-complete response.
    }
    throw new SeedbedError('Installation authorization bootstrap is already complete', ExitCode.authorization, 'bootstrap_complete');
  }
  const state = await bundle.authorizationGuard.readCurrentState();
  if (state.authorizationRevision !== 1 || state.searchGeneration !== 1) {
    throw new SeedbedError('Empty Seedbed grants do not match pristine Taproot bootstrap state', ExitCode.authorization, 'bootstrap_inconsistent');
  }
  const context = freezeContext({
    installationId: installation.installation_id,
    principalId: principalSelector,
    activeWorkspaceId: workspaceSelector,
    workspaceIds: [workspaceSelector],
    capabilities: ['knowledge:write', 'knowledge:policy', 'search:admin'],
    authorizationRevision: state.authorizationRevision,
  });
  const now = new Date().toISOString();
  const capabilities = EXACT_CAPABILITIES.map((capability) => db.prepare(
    `INSERT INTO seedbed_capability_grants (installation_id, principal_selector, capability) VALUES (?, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).bind(installation.installation_id, principalSelector, capability));
  await bundle.authorizationGuard.batchWithAuthorizationAdvance(
    context,
    { advanceId: randomUUID(), reason: 'seedbed authorization bootstrap' },
    [
      db.prepare(`INSERT INTO seedbed_principals (installation_id, selector, enabled, created_at) VALUES (?, ?, 1, ?)
        ON CONFLICT DO NOTHING`).bind(installation.installation_id, principalSelector, now),
      db.prepare(`INSERT INTO seedbed_workspaces (installation_id, selector, created_at) VALUES (?, ?, ?)
        ON CONFLICT DO NOTHING`).bind(installation.installation_id, workspaceSelector, now),
      db.prepare(`INSERT INTO seedbed_workspace_memberships (installation_id, principal_selector, workspace_selector) VALUES (?, ?, ?)
        ON CONFLICT DO NOTHING`).bind(installation.installation_id, principalSelector, workspaceSelector),
      ...capabilities,
      db.prepare(`INSERT INTO seedbed_authorization_audit
        (audit_id, installation_id, principal_selector, action, details_json, created_at) VALUES (?, ?, ?, 'bootstrap', ?, ?)`)
        .bind(randomUUID(), installation.installation_id, principalSelector, JSON.stringify({ manifestVersion: 1, workspaceSelector, capabilities: EXACT_CAPABILITIES }), now),
    ],
  );
  return bundle.resolveContext(principalSelector, workspaceSelector);
}

export interface PrincipalAuthorizationUpdate {
  readonly expectedAuthorizationRevision: number;
  readonly principalSelector: string;
  readonly enabled: boolean;
  readonly workspaceSelectors: readonly string[];
  readonly capabilities: readonly string[];
}

export interface PrincipalAuthorizationState extends PrincipalAuthorizationUpdate {
  readonly authorizationRevision: number;
}

export async function replacePrincipalAuthorization(
  db: NodeSqliteDatabase,
  config: SeedbedConfig,
  actorPrincipalSelector: string,
  actorWorkspaceSelector: string,
  update: PrincipalAuthorizationUpdate,
): Promise<PrincipalAuthorizationState> {
  validateSelector(update.principalSelector);
  const workspaceSelectors = normalizeSelectors(update.workspaceSelectors, 'workspace');
  const capabilities = normalizeCapabilities(update.capabilities);
  if (!update.enabled && (workspaceSelectors.length !== 0 || capabilities.length !== 0)) {
    throw authorizationError('A disabled principal must have empty workspace and capability sets');
  }
  if (update.enabled && workspaceSelectors.length === 0) {
    throw authorizationError('An enabled principal must have at least one workspace');
  }
  const bundle = await openAuthorization(db, config);
  const actor = await bundle.resolveContext(actorPrincipalSelector, actorWorkspaceSelector);
  if (!Number.isSafeInteger(update.expectedAuthorizationRevision) || update.expectedAuthorizationRevision < 1) {
    throw authorizationError('Expected authorization revision must be a positive safe integer');
  }
  if (actor.authorizationRevision !== update.expectedAuthorizationRevision) {
    throw new SeedbedError('Authorization manifest is stale', ExitCode.authorization, 'stale_authorization');
  }
  for (const required of ['admin', 'knowledge:write', 'knowledge:policy']) {
    if (!actor.capabilities.includes(required)) throw authorizationError(`Exact ${required} capability is required`);
  }
  const now = new Date().toISOString();
  try {
    await bundle.authorizationGuard.batchWithAuthorizationAdvance(
      actor,
      { advanceId: randomUUID(), reason: 'seedbed declarative principal authorization update' },
      [
      db.prepare(`INSERT INTO seedbed_principals (installation_id, selector, enabled, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(installation_id, selector) DO UPDATE SET enabled = excluded.enabled`)
        .bind(bundle.installationId, update.principalSelector, update.enabled ? 1 : 0, now),
      ...workspaceSelectors.map((workspaceSelector) => db.prepare(
        `INSERT INTO seedbed_workspaces (installation_id, selector, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(bundle.installationId, workspaceSelector, now)),
      db.prepare(`DELETE FROM seedbed_workspace_memberships WHERE installation_id = ? AND principal_selector = ?`)
        .bind(bundle.installationId, update.principalSelector),
      ...workspaceSelectors.map((workspaceSelector) => db.prepare(
        `INSERT INTO seedbed_workspace_memberships (installation_id, principal_selector, workspace_selector) VALUES (?, ?, ?)`,
      ).bind(bundle.installationId, update.principalSelector, workspaceSelector)),
      db.prepare(`DELETE FROM seedbed_capability_grants WHERE installation_id = ? AND principal_selector = ?`)
        .bind(bundle.installationId, update.principalSelector),
      ...capabilities.map((capability) => db.prepare(
        `INSERT INTO seedbed_capability_grants (installation_id, principal_selector, capability) VALUES (?, ?, ?)`,
      ).bind(bundle.installationId, update.principalSelector, capability)),
      db.prepare(`INSERT INTO seedbed_authorization_audit
        (audit_id, installation_id, principal_selector, action, details_json, created_at)
        VALUES (?, ?, ?, CASE WHEN EXISTS (
          SELECT 1 FROM seedbed_principals AS principal
          WHERE principal.installation_id = ? AND principal.enabled = 1
            AND EXISTS (SELECT 1 FROM seedbed_workspace_memberships AS membership
              WHERE membership.installation_id = principal.installation_id AND membership.principal_selector = principal.selector)
            AND EXISTS (SELECT 1 FROM seedbed_capability_grants AS grant_admin
              WHERE grant_admin.installation_id = principal.installation_id AND grant_admin.principal_selector = principal.selector AND grant_admin.capability = 'admin')
            AND EXISTS (SELECT 1 FROM seedbed_capability_grants AS grant_write
              WHERE grant_write.installation_id = principal.installation_id AND grant_write.principal_selector = principal.selector AND grant_write.capability = 'knowledge:write')
            AND EXISTS (SELECT 1 FROM seedbed_capability_grants AS grant_policy
              WHERE grant_policy.installation_id = principal.installation_id AND grant_policy.principal_selector = principal.selector AND grant_policy.capability = 'knowledge:policy')
        ) THEN 'principal-update' ELSE NULL END, ?, ?)`)
        .bind(
          randomUUID(),
          bundle.installationId,
          actorPrincipalSelector,
          bundle.installationId,
          JSON.stringify({ expectedAuthorizationRevision: update.expectedAuthorizationRevision, principalSelector: update.principalSelector, enabled: update.enabled, workspaceSelectors, capabilities }),
          now,
        ),
      ],
    );
  } catch (error) {
    if (error instanceof Error && /NOT NULL constraint failed:\s*seedbed_authorization_audit\.action/iu.test(error.message)) {
      throw new SeedbedError('Authorization update would remove the last enabled grant administrator', ExitCode.authorization, 'last_admin');
    }
    throw error;
  }
  const state = await bundle.authorizationGuard.readCurrentState();
  return Object.freeze({
    principalSelector: update.principalSelector,
    expectedAuthorizationRevision: update.expectedAuthorizationRevision,
    enabled: update.enabled,
    workspaceSelectors: Object.freeze(workspaceSelectors),
    capabilities: Object.freeze(capabilities),
    authorizationRevision: state.authorizationRevision,
  });
}

export async function openAuthorization(db: NodeSqliteDatabase, config: SeedbedConfig): Promise<SeedbedAuthorityBundle> {
  const installation = await readInstallation(db);
  if (!installation) throw authorizationError('Authorization is not bootstrapped; run seedbed auth bootstrap');
  return createAuthorityBundle(db, config, installation);
}

async function createAuthorityBundle(db: NodeSqliteDatabase, config: SeedbedConfig, installation: InstallationRow): Promise<SeedbedAuthorityBundle> {
  const baseIri = requireBaseIri(config);
  if (installation.base_iri !== baseIri) throw authorizationError('Installation binding does not match the configured base IRI');
  const keys = await deriveInstallationKeys(config, installation.installation_id);
  const expectedBinding = await installationBinding(keys.binding, installation.installation_id, baseIri);
  if (!sameTag(expectedBinding, installation.binding_tag)) throw authorizationError('Root secret does not match this installation');
  const host = createTaprootHostWriteCapability(db, { baseIri }, keys.hostWrite);
  const authorizationGuard = await createInstallationAuthorizationGuard(db, { baseIri }, host);
  const taskGuard = await createInstallationDomainMutationGuard(db, { baseIri }, host, { domain: 'workshop-task-write', capability: 'task-write' });
  const memoryGuard = await createInstallationDomainMutationGuard(db, { baseIri }, host, { domain: 'workshop-memory-write', capability: 'memory-write' });
  const taskBackfillGuard = await createInstallationDomainMutationGuard(db, { baseIri }, host, { domain: 'workshop-task-backfill', capability: 'search:admin' });
  const memoryBackfillGuard = await createInstallationDomainMutationGuard(db, { baseIri }, host, { domain: 'workshop-memory-backfill', capability: 'search:admin' });
  const cursorGuard = await createInstallationDomainMutationGuard(db, { baseIri }, host, { domain: 'workshop-cursor-snapshot', capability: 'read' });
  const persistence = taggedPersistence(db);
  const authority = workshopAuthority(persistence, authorizationGuard, taskGuard, memoryGuard, taskBackfillGuard, memoryBackfillGuard, cursorGuard);
  const resolveContext = async (principalSelector: string, workspaceSelector?: string): Promise<AuthorizationContext> => {
    validateSelector(principalSelector);
    if (workspaceSelector !== undefined) validateSelector(workspaceSelector);
    const state = await authorizationGuard.readCurrentState();
    const principalStatement = db.prepare(`SELECT enabled FROM seedbed_principals WHERE installation_id = ? AND selector = ?`)
      .bind(installation.installation_id, principalSelector) as D1PreparedStatementLike;
    const principal = await principalStatement.first<{ enabled: number }>();
    if (principal?.enabled !== 1) throw authorizationError('Principal selector is not active');
    const memberships = await db.prepare(`SELECT workspace_selector FROM seedbed_workspace_memberships
      WHERE installation_id = ? AND principal_selector = ? ORDER BY workspace_selector`)
      .bind(installation.installation_id, principalSelector).all<{ workspace_selector: string }>();
    const workspaceIds = memberships.results.map(({ workspace_selector }) => workspace_selector);
    if (workspaceSelector !== undefined && !workspaceIds.includes(workspaceSelector)) throw authorizationError('Workspace selector is not granted');
    const grants = await db.prepare(`SELECT capability FROM seedbed_capability_grants
      WHERE installation_id = ? AND principal_selector = ? ORDER BY capability`)
      .bind(installation.installation_id, principalSelector).all<{ capability: string }>();
    return freezeContext({
      installationId: installation.installation_id,
      principalId: principalSelector,
      activeWorkspaceId: workspaceSelector ?? null,
      workspaceIds,
      capabilities: grants.results.map(({ capability }) => capability),
      authorizationRevision: state.authorizationRevision,
    });
  };
  return {
    installationId: installation.installation_id,
    authority,
    persistence,
    authorizationGuard,
    hostCapability: host,
    cursorCodec: createCursorCodec(keys, String(installation.cursor_key_generation)),
    authorizedReader(context) {
      return createAuthorizedTaproot(db, { baseIri }, context, {
        cursorCodec: createAuthorizationCursorCodec(keys.taprootCursorAead),
      });
    },
    async resolveSearchAdminContext() {
      const statement = db.prepare(`SELECT p.selector
        FROM seedbed_principals p
        JOIN seedbed_capability_grants g
          ON g.installation_id = p.installation_id AND g.principal_selector = p.selector
        WHERE p.installation_id = ? AND p.enabled = 1 AND g.capability = 'search:admin'
        ORDER BY p.selector LIMIT 1`).bind(installation.installation_id) as D1PreparedStatementLike;
      const row = await statement.first<{ selector: string }>();
      if (!row) throw authorizationError('No active search administrator is available for producer registration');
      return resolveContext(row.selector);
    },
    resolveContext,
  };
}

function workshopAuthority(
  persistence: WorkshopPersistence,
  authorization: InstallationAuthorizationGuard,
  task: InstallationDomainMutationGuard,
  memory: InstallationDomainMutationGuard,
  taskBackfill: InstallationDomainMutationGuard,
  memoryBackfill: InstallationDomainMutationGuard,
  cursor: InstallationDomainMutationGuard,
): WorkshopAuthorizationAuthority {
  const batchOne = async <T>(guard: InstallationDomainMutationGuard, context: AuthorizationContext, mutation: D1PreparedStatementLike) => {
    try {
      const receipt = await guard.batchWithExpectedRevision(context, [unwrapStatement(mutation)]);
      return (receipt.results[0]?.results[0] as T | undefined) ?? null;
    } catch (error) {
      throw translateAuthorization(error);
    }
  };
  const batchMany = async (guard: InstallationDomainMutationGuard, context: AuthorizationContext, expected: { installationId: string; authorizationRevision: number; searchGeneration: number }, statements: readonly D1PreparedStatementLike[]) => {
    try {
      const assertion = persistence.prepare(`INSERT INTO taproot_assertions(assertion_key)
        SELECT NULL WHERE NOT EXISTS (
          SELECT 1 FROM taproot_installation_authorization
          WHERE singleton = 1 AND installation_id = ? AND authorization_revision = ? AND search_generation = ?
        )`).bind(expected.installationId, expected.authorizationRevision, expected.searchGeneration);
      const receipt = await guard.batchWithExpectedRevision(context, [...statements.map(unwrapStatement), unwrapStatement(assertion)]);
      return receipt.results.slice(0, statements.length);
    } catch (error) {
      throw translateAuthorization(error);
    }
  };
  return {
    getInstallationAuthorizationState: () => authorization.readCurrentState(),
    commitTaskMutation: <T>(_db: unknown, context: AuthorizationContext, mutation: D1PreparedStatementLike) => batchOne<T>(task, context, mutation),
    commitMemoryMutation: <T>(_db: unknown, context: AuthorizationContext, mutation: D1PreparedStatementLike) => batchOne<T>(memory, context, mutation),
    commitTaskBackfill: (_db, context, state, statements) => batchMany(taskBackfill, context, state, statements),
    commitMemoryBackfill: (_db, context, state, statements) => batchMany(memoryBackfill, context, state, statements),
    async commitCursorSnapshot(_db, context, state, statements) {
      const domains = new Set<string>();
      for (const statement of statements) {
        const tagged = statement as Partial<TaggedStatement>;
        if (!tagged.__seedbedSql || !tagged.__seedbedValues) throw workshopDenied();
        if (/INSERT INTO workshop_cursor_snapshots/u.test(tagged.__seedbedSql)) domains.add(String(tagged.__seedbedValues[6]));
        else if (!/workshop_cursor_(?:snapshots|entries)/u.test(tagged.__seedbedSql)) throw workshopDenied();
      }
      if (domains.size !== 1) throw workshopDenied();
      const domain = [...domains][0];
      if (domain === 'task' || domain === 'memory') return batchMany(cursor, context, state, statements);
      throw workshopDenied();
    },
  };
}

function taggedPersistence(db: NodeSqliteDatabase): WorkshopPersistence {
  return {
    prepare(sql: string) {
      const values: unknown[] = [];
      const underlying = db.prepare(sql);
      const wrap = (prepared: ReturnType<NodeSqliteDatabase['prepare']>, boundValues: unknown[]): TaggedStatement => ({
        __seedbedSql: sql,
        __seedbedValues: boundValues,
        __seedbedUnderlying: prepared as unknown as D1PreparedStatementLike,
        bind(...bound: unknown[]) {
          return wrap(prepared.bind(...bound) as ReturnType<NodeSqliteDatabase['prepare']>, [...bound]);
        },
        run: <T>() => prepared.run<T>(),
        all: <T>() => prepared.all<T>(),
        first: <T>(_column?: string) => prepared.first<T>(),
      });
      return wrap(underlying, values);
    },
    batch: <T>(statements: D1PreparedStatementLike[]) => db.batch<T>(statements.map(unwrapStatement)),
  };
}

function createCursorCodec(keys: InstallationKeys, generation: string): WorkshopCursorCodec {
  const encoder = new TextEncoder();
  return {
    async currentGeneration() { return generation; },
    async digest(purpose, value) {
      const data = concat(encoder.encode(`${purpose}\0`), value);
      return base64url(new Uint8Array(await subtle.sign('HMAC', keys.cursorDigest, data)));
    },
    async seal(current, plaintext) {
      if (current !== generation) throw authorizationError('Unknown cursor-key generation');
      const iv = randomBytes(12);
      const encrypted = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(current) }, keys.cursorAead, plaintext));
      return `${base64url(iv)}.${base64url(encrypted)}`;
    },
    async open(current, token) {
      if (current !== generation) throw authorizationError('Unknown cursor-key generation');
      const parts = token.split('.');
      if (parts.length !== 2) throw authorizationError('Invalid cursor');
      return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: fromBase64url(parts[0]!), additionalData: encoder.encode(current) }, keys.cursorAead, fromBase64url(parts[1]!)));
    },
  };
}

async function installationBinding(key: webcrypto.CryptoKey, installationId: string, baseIri: string): Promise<string> {
  return base64url(new Uint8Array(await subtle.sign('HMAC', key, new TextEncoder().encode(`seedbed-installation-v1\0${installationId}\0${baseIri}`))));
}

async function readInstallation(db: NodeSqliteDatabase): Promise<InstallationRow | null> {
  try {
    return db.prepare(`SELECT installation_id, base_iri, binding_tag, cursor_key_generation FROM seedbed_installation WHERE singleton = 1`).first<InstallationRow>();
  } catch (error) {
    if (error instanceof Error && /no such table:\s*seedbed_installation/iu.test(error.message)) return null;
    throw error;
  }
}

function freezeContext(value: AuthorizationContext): AuthorizationContext {
  const workspaceIds = Object.freeze([...value.workspaceIds]);
  const capabilities = Object.freeze([...value.capabilities]);
  return Object.freeze({ ...value, workspaceIds, capabilities });
}

function sameExactSet(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function validateSelector(value: string): void {
  if (!value || value.length > 256 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) throw authorizationError('Selector is invalid');
}

function normalizeSelectors(values: readonly string[], label: string): string[] {
  for (const value of values) validateSelector(value);
  const normalized = [...new Set(values)].sort();
  if (normalized.length !== values.length) throw authorizationError(`${label} selector set contains duplicates`);
  return normalized;
}

function normalizeCapabilities(values: readonly string[]): ExactCapability[] {
  const normalized = [...new Set(values)].sort();
  if (normalized.length !== values.length) throw authorizationError('Capability set contains duplicates');
  if (normalized.some((capability) => !(EXACT_CAPABILITIES as readonly string[]).includes(capability))) {
    throw authorizationError('Capability set contains an unknown exact capability');
  }
  return normalized as ExactCapability[];
}

function translateAuthorization(error: unknown): Error {
  if (error instanceof AuthorizationDeniedError || error instanceof InvalidAuthorizationError) return workshopDenied();
  return error instanceof Error ? error : new Error(String(error));
}

function workshopDenied(): WorkshopError { return new WorkshopError('forbidden', 'Authorization denied'); }

function authorizationError(message: string): SeedbedError {
  return new SeedbedError(message, ExitCode.authorization, 'forbidden');
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function base64url(value: Uint8Array): string { return Buffer.from(value).toString('base64url'); }
function fromBase64url(value: string): Uint8Array { return new Uint8Array(Buffer.from(value, 'base64url')); }
function sameTag(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'base64url');
  const rightBytes = Buffer.from(right, 'base64url');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
function unwrapStatement(statement: D1PreparedStatementLike): D1PreparedStatementLike {
  return (statement as Partial<TaggedStatement>).__seedbedUnderlying ?? statement;
}

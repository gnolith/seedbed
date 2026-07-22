import { chmod, mkdtemp, open, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SeedbedConfig } from '../src/config.js';
import { bootstrapAuthorization, EXACT_CAPABILITIES, openAuthorization, replacePrincipalAuthorization } from '../src/authorization.js';
import { deriveInstallationKeys } from '../src/secrets.js';
import { initializeDatabase, openDatabase } from '../src/persistence.js';
import { loadTaprootAssembly } from '../src/taproot-bridge.js';

async function fixture(): Promise<{ config: SeedbedConfig; wrongSecret: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'seedbed-authorization-'));
  const secret = join(directory, 'root.key');
  const wrongSecret = join(directory, 'wrong.key');
  await writeFile(secret, Buffer.alloc(32, 0x41), { mode: 0o600 });
  await writeFile(wrongSecret, Buffer.alloc(32, 0x42), { mode: 0o600 });
  return {
    config: {
      databasePath: join(directory, 'gnolith.sqlite'),
      baseIri: 'https://authorization.seedbed.test/installation/',
      rootSecretFile: secret,
      principalSelector: 'owner',
      workspaceSelector: 'workspace',
      logLevel: 'silent',
      shutdownTimeoutMs: 1_000,
    },
    wrongSecret,
  };
}

describe('installation authorization', () => {
  it('quarantines an initialized assembly until explicit bootstrap', async () => {
    const { config } = await fixture();
    await initializeDatabase(config, await loadTaprootAssembly());
    const db = await openDatabase(config);
    try {
      await expect(openAuthorization(db, config)).rejects.toMatchObject({ code: 'forbidden' });
    } finally {
      await db.close();
    }
  });

  it('persists an immutable binding and resolves only frozen live grants after restart', async () => {
    const { config, wrongSecret } = await fixture();
    await initializeDatabase(config, await loadTaprootAssembly());
    let db = await openDatabase(config);
    const context = await bootstrapAuthorization(db, config, 'owner', 'workspace');
    expect(context.capabilities).toEqual([...EXACT_CAPABILITIES].sort());
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.capabilities)).toBe(true);
    expect(Object.isFrozen(context.workspaceIds)).toBe(true);
    await db.close();

    db = await openDatabase(config);
    try {
      const bundle = await openAuthorization(db, config);
      await expect(bundle.resolveContext('owner', 'workspace')).resolves.toEqual(context);
      await expect(bundle.authority.commitTaskMutation(
        bundle.persistence,
        context,
        bundle.persistence.prepare('SELECT 1 AS value'),
      )).resolves.toEqual({ value: 1 });
      await expect(openAuthorization(db, { ...config, rootSecretFile: wrongSecret })).rejects.toMatchObject({ code: 'forbidden' });
    } finally {
      await db.close();
    }
  });

  it('invalidates a previously issued context when bootstrap advances the sole Taproot revision', async () => {
    const { config } = await fixture();
    await initializeDatabase(config, await loadTaprootAssembly());
    const db = await openDatabase(config);
    try {
      const stale = await bootstrapAuthorization(db, config, 'owner', 'workspace');
      const before = await openAuthorization(db, config);
      const secondProcess = await openDatabase(config);
      try {
        await replacePrincipalAuthorization(secondProcess, config, 'owner', 'workspace', {
          expectedAuthorizationRevision: stale.authorizationRevision,
          principalSelector: 'second-owner',
          enabled: true,
          workspaceSelectors: ['workspace'],
          capabilities: ['read'],
        });
      } finally {
        await secondProcess.close();
      }
      await expect(before.authority.commitTaskMutation(
        before.persistence,
        stale,
        before.persistence.prepare('SELECT 1 AS value'),
      )).rejects.toBeDefined();
      const current = await before.resolveContext('owner', 'workspace');
      expect(current.authorizationRevision).toBe(stale.authorizationRevision + 1);
    } finally {
      await db.close();
    }
  });

  it('atomically replaces and revokes exact workspaces, capabilities, and enabled state across restart', async () => {
    const { config } = await fixture();
    await initializeDatabase(config, await loadTaprootAssembly());
    let db = await openDatabase(config);
    const owner = await bootstrapAuthorization(db, config, 'owner', 'workspace');
    const granted = await replacePrincipalAuthorization(db, config, 'owner', 'workspace', {
      expectedAuthorizationRevision: owner.authorizationRevision,
      principalSelector: 'worker',
      enabled: true,
      workspaceSelectors: ['other-workspace', 'workspace'],
      capabilities: ['read', 'task-write'],
    });
    const bundle = await openAuthorization(db, config);
    const stale = await bundle.resolveContext('worker', 'workspace');
    const staleState = await bundle.authority.getInstallationAuthorizationState();
    if (!staleState) throw new Error('Taproot authorization state is missing');
    expect(granted.workspaceSelectors).toEqual(['other-workspace', 'workspace']);
    expect(stale.capabilities).toEqual(['read', 'task-write']);

    const narrowedState = await replacePrincipalAuthorization(db, config, 'owner', 'workspace', {
      expectedAuthorizationRevision: granted.authorizationRevision,
      principalSelector: 'worker',
      enabled: true,
      workspaceSelectors: ['other-workspace'],
      capabilities: [],
    });
    await expect(bundle.resolveContext('worker', 'workspace')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(bundle.authority.commitTaskMutation(
      bundle.persistence,
      stale,
      bundle.persistence.prepare('SELECT 1 AS value'),
    )).rejects.toMatchObject({ code: 'forbidden' });
    await expect(bundle.authority.commitCursorSnapshot(bundle.persistence, stale, staleState, [
      bundle.persistence.prepare(`INSERT INTO workshop_cursor_snapshots
        (id, installation_id, principal_id, grant_digest, authorization_revision, search_generation,
         domain, operation, query_digest, filters_digest, page_size, entry_count, issued_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind('revoked-cursor', bundle.installationId, 'worker', 'digest', stale.authorizationRevision,
          staleState.searchGeneration, 'task', 'list', 'query', 'filters', 1, 1,
          '2026-07-22T00:00:00.000Z', '2026-07-23T00:00:00.000Z'),
    ])).rejects.toMatchObject({ code: 'forbidden' });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM workshop_cursor_snapshots WHERE id = 'revoked-cursor'").first<{ count: number }>())
      .toEqual({ count: 0 });
    const narrowed = await bundle.resolveContext('worker', 'other-workspace');
    expect(narrowed.capabilities).toEqual([]);

    await replacePrincipalAuthorization(db, config, 'owner', 'workspace', {
      expectedAuthorizationRevision: narrowedState.authorizationRevision,
      principalSelector: 'worker',
      enabled: false,
      workspaceSelectors: [],
      capabilities: [],
    });
    await db.close();

    db = await openDatabase(config);
    try {
      const reopened = await openAuthorization(db, config);
      await expect(reopened.resolveContext('worker', 'other-workspace')).rejects.toMatchObject({ code: 'forbidden' });
      const principal = (await db.prepare(`SELECT enabled FROM seedbed_principals WHERE installation_id = ? AND selector = 'worker'`)
        .bind(reopened.installationId).all<{ enabled: number }>()).results[0];
      const memberships = (await db.prepare(`SELECT COUNT(*) AS count FROM seedbed_workspace_memberships WHERE installation_id = ? AND principal_selector = 'worker'`)
        .bind(reopened.installationId).all<{ count: number }>()).results[0];
      const capabilities = (await db.prepare(`SELECT COUNT(*) AS count FROM seedbed_capability_grants WHERE installation_id = ? AND principal_selector = 'worker'`)
        .bind(reopened.installationId).all<{ count: number }>()).results[0];
      expect(principal?.enabled).toBe(0);
      expect(memberships?.count).toBe(0);
      expect(capabilities?.count).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('rejects removal of the last enabled grant administrator with zero partial writes', async () => {
    const { config } = await fixture();
    await initializeDatabase(config, await loadTaprootAssembly());
    const db = await openDatabase(config);
    try {
      const owner = await bootstrapAuthorization(db, config, 'owner', 'workspace');
      const bundle = await openAuthorization(db, config);
      const auditBefore = await db.prepare('SELECT COUNT(*) AS count FROM seedbed_authorization_audit').first<{ count: number }>();
      await expect(replacePrincipalAuthorization(db, config, 'owner', 'workspace', {
        expectedAuthorizationRevision: owner.authorizationRevision,
        principalSelector: 'owner',
        enabled: false,
        workspaceSelectors: [],
        capabilities: [],
      })).rejects.toMatchObject({ code: 'last_admin' });
      await expect(bundle.resolveContext('owner', 'workspace')).resolves.toEqual(owner);
      const auditAfter = await db.prepare('SELECT COUNT(*) AS count FROM seedbed_authorization_audit').first<{ count: number }>();
      expect(auditAfter).toEqual(auditBefore);
      expect((await bundle.authorizationGuard.readCurrentState()).authorizationRevision).toBe(owner.authorizationRevision);
    } finally {
      await db.close();
    }
  });

  it('serializes concurrent two-process authorization updates without partial loser state', async () => {
    const { config } = await fixture();
    await initializeDatabase(config, await loadTaprootAssembly());
    const first = await openDatabase(config);
    const second = await openDatabase(config);
    try {
      const owner = await bootstrapAuthorization(first, config, 'owner', 'workspace');
      const prepared = await replacePrincipalAuthorization(first, config, 'owner', 'workspace', {
        expectedAuthorizationRevision: owner.authorizationRevision,
        principalSelector: 'concurrent-victim', enabled: true, workspaceSelectors: ['workspace'], capabilities: ['read'],
      });
      const updates = [
        replacePrincipalAuthorization(first, config, 'owner', 'workspace', {
          expectedAuthorizationRevision: prepared.authorizationRevision,
          principalSelector: 'concurrent-victim', enabled: false, workspaceSelectors: [], capabilities: [],
        }),
        replacePrincipalAuthorization(second, config, 'owner', 'workspace', {
          expectedAuthorizationRevision: prepared.authorizationRevision,
          principalSelector: 'concurrent-winner', enabled: true, workspaceSelectors: ['workspace'], capabilities: ['read'],
        }),
      ];
      const settled = await Promise.allSettled(updates);
      expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(settled.filter(({ status }) => status === 'rejected')).toHaveLength(1);
      const bundle = await openAuthorization(first, config);
      expect((await bundle.authorizationGuard.readCurrentState()).authorizationRevision).toBe(prepared.authorizationRevision + 1);
      const state = await first.prepare(`SELECT
        (SELECT enabled FROM seedbed_principals WHERE selector = 'concurrent-victim') AS victim_enabled,
        (SELECT COUNT(*) FROM seedbed_workspace_memberships WHERE principal_selector = 'concurrent-victim') AS victim_memberships,
        (SELECT COUNT(*) FROM seedbed_capability_grants WHERE principal_selector = 'concurrent-victim') AS victim_capabilities,
        (SELECT COUNT(*) FROM seedbed_principals WHERE selector = 'concurrent-winner') AS winner_principals,
        (SELECT COUNT(*) FROM seedbed_workspace_memberships WHERE principal_selector = 'concurrent-winner') AS winner_memberships,
        (SELECT COUNT(*) FROM seedbed_capability_grants WHERE principal_selector = 'concurrent-winner') AS winner_capabilities`)
        .first<Record<string, number>>();
      expect(state).toEqual(settled[0]?.status === 'fulfilled'
        ? { victim_enabled: 0, victim_memberships: 0, victim_capabilities: 0, winner_principals: 0, winner_memberships: 0, winner_capabilities: 0 }
        : { victim_enabled: 1, victim_memberships: 1, victim_capabilities: 1, winner_principals: 1, winner_memberships: 1, winner_capabilities: 1 });
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('requires durable exact admin and Taproot policy capabilities without requiring search administration', async () => {
    const { config } = await fixture();
    await initializeDatabase(config, await loadTaprootAssembly());
    const db = await openDatabase(config);
    try {
      const owner = await bootstrapAuthorization(db, config, 'owner', 'workspace');
      const delegated = await replacePrincipalAuthorization(db, config, 'owner', 'workspace', {
        expectedAuthorizationRevision: owner.authorizationRevision,
        principalSelector: 'grant-admin',
        enabled: true,
        workspaceSelectors: ['workspace'],
        capabilities: ['admin', 'knowledge:policy', 'knowledge:write'],
      });
      const worker = await replacePrincipalAuthorization(db, config, 'grant-admin', 'workspace', {
        expectedAuthorizationRevision: delegated.authorizationRevision,
        principalSelector: 'worker',
        enabled: true,
        workspaceSelectors: ['workspace'],
        capabilities: ['read'],
      });
      const narrowed = await replacePrincipalAuthorization(db, config, 'owner', 'workspace', {
        expectedAuthorizationRevision: worker.authorizationRevision,
        principalSelector: 'grant-admin',
        enabled: true,
        workspaceSelectors: ['workspace'],
        capabilities: ['admin', 'knowledge:write'],
      });
      await expect(replacePrincipalAuthorization(db, config, 'grant-admin', 'workspace', {
        expectedAuthorizationRevision: narrowed.authorizationRevision,
        principalSelector: 'worker',
        enabled: false,
        workspaceSelectors: [],
        capabilities: [],
      })).rejects.toMatchObject({ code: 'forbidden' });
      await expect((await openAuthorization(db, config)).resolveContext('worker', 'workspace')).resolves.toMatchObject({
        capabilities: ['read'],
      });
    } finally {
      await db.close();
    }
  });

  it('derives only non-extractable domain keys from an exact 32-byte source', async () => {
    const { config } = await fixture();
    const keys = await deriveInstallationKeys(config, 'installation');
    for (const key of Object.values(keys)) expect(key.extractable).toBe(false);
  });

  it('rejects ambiguous and incorrectly sized root-secret sources', async () => {
    const { config } = await fixture();
    const { rootSecretFile: _rootSecretFile, ...withoutSecretFile } = config;
    await expect(deriveInstallationKeys(withoutSecretFile, 'installation'))
      .rejects.toMatchObject({ code: 'invalid_root_secret' });
    await expect(deriveInstallationKeys({ ...config, rootSecretFd: 0 }, 'installation'))
      .rejects.toMatchObject({ code: 'invalid_root_secret' });
    await writeFile(config.rootSecretFile!, Buffer.alloc(31), { mode: 0o600 });
    await expect(deriveInstallationKeys(config, 'installation'))
      .rejects.toMatchObject({ code: 'invalid_root_secret' });
  });

  it('accepts an exact root secret from an inherited descriptor without closing it', async () => {
    const { config } = await fixture();
    const { rootSecretFile, ...withoutSecretFile } = config;
    const handle = await open(rootSecretFile!, 'r');
    try {
      const keys = await deriveInstallationKeys({ ...withoutSecretFile, rootSecretFd: handle.fd }, 'installation');
      expect(keys.binding.extractable).toBe(false);
      await expect(handle.stat()).resolves.toMatchObject({ size: 32 });
    } finally {
      await handle.close();
    }
  });

  it.skipIf(process.platform === 'win32')('rejects symbolic links and group-readable root-secret files', async () => {
    const { config } = await fixture();
    const link = `${config.rootSecretFile!}.link`;
    await symlink(config.rootSecretFile!, link);
    await expect(deriveInstallationKeys({ ...config, rootSecretFile: link }, 'installation'))
      .rejects.toMatchObject({ code: 'invalid_root_secret' });
    await chmod(config.rootSecretFile!, 0o640);
    await expect(deriveInstallationKeys(config, 'installation'))
      .rejects.toMatchObject({ code: 'invalid_root_secret' });
  });

  it('binds Workshop mutation, backfill, and cursor batches to their exact capabilities', async () => {
    const { config } = await fixture();
    await initializeDatabase(config, await loadTaprootAssembly());
    const db = await openDatabase(config);
    try {
      const owner = await bootstrapAuthorization(db, config, 'owner', 'workspace');
      const bundle = await openAuthorization(db, config);
      const state = await bundle.authority.getInstallationAuthorizationState();
      if (!state) throw new Error('Taproot authorization state is missing');
      const narrow = (capabilities: string[]) => Object.freeze({ ...owner, capabilities: Object.freeze(capabilities) });
      await expect(bundle.authority.commitTaskMutation(
        bundle.persistence,
        narrow(['read']),
        bundle.persistence.prepare('SELECT 1 AS value'),
      )).rejects.toMatchObject({ code: 'forbidden' });
      await expect(bundle.authority.commitTaskBackfill(
        bundle.persistence,
        narrow(['search:admin']),
        state,
        [bundle.persistence.prepare('SELECT 1 AS value')],
      )).resolves.toHaveLength(1);
      await expect(bundle.authority.commitCursorSnapshot(
        bundle.persistence,
        narrow(['read']),
        state,
        [bundle.persistence.prepare('DELETE FROM workshop_tasks WHERE id = ?').bind('forbidden-cross-domain')],
      )).rejects.toMatchObject({ code: 'forbidden' });
    } finally {
      await db.close();
    }
  });

  it('makes bootstrap one-time and idempotent only for the exact durable manifest', async () => {
    const { config } = await fixture();
    await initializeDatabase(config, await loadTaprootAssembly());
    const db = await openDatabase(config);
    try {
      const first = await bootstrapAuthorization(db, config, 'owner', 'workspace');
      const repeated = await bootstrapAuthorization(db, config, 'owner', 'workspace');
      expect(repeated).toEqual(first);
      await expect(bootstrapAuthorization(db, config, 'other', 'workspace')).rejects.toMatchObject({ code: 'bootstrap_complete' });
      const bundle = await openAuthorization(db, config);
      expect((await bundle.authority.getInstallationAuthorizationState())?.authorizationRevision).toBe(first.authorizationRevision);
      await expect(bundle.authorizationGuard.batchWithAuthorizationAdvance(
        { ...first, principalId: 'bootstrap-manifest', capabilities: ['knowledge:write', 'knowledge:policy'], authorizationRevision: 1 },
        { advanceId: 'bootstrap-manifest-reuse', reason: 'must be rejected' },
        [db.prepare('SELECT 1')],
      )).rejects.toBeDefined();
      await replacePrincipalAuthorization(db, config, 'owner', 'workspace', {
        expectedAuthorizationRevision: first.authorizationRevision,
        principalSelector: 'owner',
        enabled: true,
        workspaceSelectors: ['workspace', 'other-workspace'],
        capabilities: EXACT_CAPABILITIES,
      });
      await expect(bootstrapAuthorization(db, config, 'owner', 'other-workspace')).rejects.toMatchObject({ code: 'bootstrap_complete' });
      await expect(bootstrapAuthorization(db, config, 'owner', 'workspace')).rejects.toMatchObject({ code: 'bootstrap_complete' });
    } finally {
      await db.close();
    }
  });

  it('rolls back every first-grant row and the Taproot advance when the bootstrap batch fails', async () => {
    const { config } = await fixture();
    await initializeDatabase(config, await loadTaprootAssembly());
    const db = await openDatabase(config);
    try {
      await db.prepare(`CREATE TRIGGER reject_seedbed_bootstrap BEFORE INSERT ON seedbed_capability_grants
        BEGIN SELECT RAISE(ABORT, 'injected bootstrap failure'); END`).run();
      await expect(bootstrapAuthorization(db, config, 'owner', 'workspace')).rejects.toThrow(/bootstrap failure/u);
      const bundle = await openAuthorization(db, config);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM seedbed_principals').first()).toEqual({ count: 0 });
      expect((await bundle.authority.getInstallationAuthorizationState())?.authorizationRevision).toBe(1);
      await db.prepare('DROP TRIGGER reject_seedbed_bootstrap').run();
      await expect(bootstrapAuthorization(db, config, 'owner', 'workspace')).resolves.toMatchObject({ principalId: 'owner', authorizationRevision: 2 });
    } finally {
      await db.close();
    }
  });

  it('allows only one of two concurrent bootstrap manifests to become durable', async () => {
    const { config } = await fixture();
    await initializeDatabase(config, await loadTaprootAssembly());
    const first = await openDatabase(config);
    const second = await openDatabase(config);
    try {
      const outcomes = await Promise.allSettled([
        bootstrapAuthorization(first, config, 'first', 'workspace'),
        bootstrapAuthorization(second, config, 'second', 'workspace'),
      ]);
      expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      const inspection = await openAuthorization(first, config);
      const state = await inspection.authority.getInstallationAuthorizationState();
      expect(state?.authorizationRevision).toBe(2);
      const principals = await first.prepare('SELECT selector FROM seedbed_principals ORDER BY selector').all<{ selector: string }>();
      expect(principals.results).toHaveLength(1);
    } finally {
      await first.close();
      await second.close();
    }
  });
});

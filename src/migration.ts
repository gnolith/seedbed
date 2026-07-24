import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalJson, digestObject } from './canonical.js';
import { createLocalBearerCredential, inspectProtectedCredential } from './secrets.js';
import { OWNER_LEDGER_NAMESPACES, OWNER_ORDER, type InstallationPlan, type InstallationReceipt, type OwnerDiagnostic, type SeedbedConfig } from './types.js';
import type { InstallationPorts } from './owner-ports.js';
import { acquireOperationLock } from './operation-lock.js';

export interface ComposeDriver {
  prepare(config: SeedbedConfig): Promise<void>;
  buildOperator?(config: SeedbedConfig): Promise<void>;
  up(config: SeedbedConfig): Promise<void>;
  health(config: SeedbedConfig): Promise<{ healthy: boolean }>;
  downRetainData(config: SeedbedConfig): Promise<void>;
}

interface OperationState {
  readonly format: 'gnolith-seedbed-operation-state-v1';
  readonly operationId: string;
  readonly configDigest: string;
  readonly completed: readonly string[];
  readonly quarantined: boolean;
  readonly issue?: { code: string; phase: string; remediation: string };
}

export function createInstallationPlan(config: SeedbedConfig): InstallationPlan {
  const digest = digestObject(config);
  const migrations = OWNER_ORDER.map((owner) => ({
    owner,
    expectedVersion: config.migrations[owner],
    packageSha256: config.packages[owner].sha256,
  }));
  const body = {
    format: 'gnolith-seedbed-install-plan-v1' as const,
    configDigest: digest,
    steps: [
      'validate-inputs', 'prepare-storage', 'diamond-migrate', 'taproot-migrate',
      'workshop-migrate', 'workshop-bootstrap-v1', 'compose-up',
      'verify-owner-state', 'write-receipt',
    ] as const,
    migrations,
  };
  return { ...body, operationId: digestObject(body) };
}

export function createMigrationPlan(config: SeedbedConfig): InstallationPlan {
  const plan = createInstallationPlan(config);
  const body = {
    ...plan,
    steps: ['validate-inputs', 'prepare-storage', 'diamond-migrate', 'taproot-migrate', 'workshop-migrate', 'verify-owner-state'] as const,
  };
  return { ...body, operationId: digestObject({ ...body, operationId: undefined }) };
}

export async function applyInstallationPlan(input: {
  config: SeedbedConfig;
  plan: InstallationPlan;
  ports: InstallationPorts;
  compose: ComposeDriver;
  interruptAfter?: string;
}): Promise<InstallationReceipt> {
  assertPlan(input.config, input.plan);
  const operationDirectory = join(input.config.paths.stateDirectory, 'operations');
  await mkdir(operationDirectory, { recursive: true, mode: 0o700 });
  const statePath = join(operationDirectory, `${input.plan.operationId}.json`);
  const lock = await acquireOperationLock(join(operationDirectory, 'installation-operation.lock'), input.plan.operationId);
  try {
    let state = await readState(statePath, input.plan);
    const completed = new Set(state.completed);
    const diagnostics = new Map<string, OwnerDiagnostic>();
    let credential: Awaited<ReturnType<typeof createLocalBearerCredential>> | undefined;
    for (const step of input.plan.steps) {
      if (completed.has(step)) continue;
      try {
        switch (step) {
          case 'validate-inputs':
            await input.compose.prepare(input.config);
            break;
          case 'prepare-storage':
            await Promise.all([
              mkdir(input.config.paths.dataDirectory, { recursive: true, mode: 0o700 }),
              mkdir(input.config.paths.backupDirectory, { recursive: true, mode: 0o700 }),
            ]);
            if (input.compose.buildOperator) await input.compose.buildOperator(input.config);
            break;
          case 'diamond-migrate':
          case 'taproot-migrate':
          case 'workshop-migrate': {
            const owner = step.slice(0, -'-migrate'.length) as typeof OWNER_ORDER[number];
            const proposed = await input.ports[owner].planMigration(input.config.migrations[owner]);
            if (proposed.target !== input.config.migrations[owner]) throw new TypeError(`${owner} migration target mismatch`);
            {
              const diagnostic = await input.ports[owner].applyMigration(input.config.migrations[owner], input.plan.operationId);
              assertOwnerDiagnostic(diagnostic, owner, input.config);
              diagnostics.set(owner, diagnostic);
            }
            break;
          }
          case 'workshop-bootstrap-v1':
            try {
              const existing = await inspectProtectedCredential(input.config.authentication.tokenFile);
              credential = {
                credentialId: input.config.authentication.credentialId,
                credentialDigest: existing.credentialDigest,
                protectedFile: input.config.authentication.tokenFile,
                requiredEnvironmentSelector: 'GNOLITH_BEARER_TOKEN',
              };
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              credential = await createLocalBearerCredential(input.config.authentication.credentialId, input.config.authentication.tokenFile);
            }
            {
              const result = await input.ports.workshop.bootstrapV1({
                installationId: input.config.installationId,
                baseIri: input.config.baseIri,
                credentialId: input.config.authentication.credentialId,
                tokenFile: input.config.authentication.tokenFile,
                operationId: input.plan.operationId,
              });
              if (result.installationId !== input.config.installationId || result.baseIri !== input.config.baseIri || result.catalogDigest !== input.config.migrations.expectedCatalogDigest) {
                throw new TypeError('Workshop bootstrap identity or catalog mismatch');
              }
              if (!/^[0-9a-f]{64}$/u.test(result.credentialDigest) || !result.credentialId) {
                throw new TypeError('Workshop bootstrap credential receipt mismatch');
              }
              credential = { ...credential, credentialId: result.credentialId };
            }
            break;
          case 'compose-up':
            await input.compose.up(input.config);
            break;
          case 'verify-owner-state':
            for (const owner of OWNER_ORDER) {
              const diagnostic = await input.ports[owner].diagnose();
              assertOwnerDiagnostic(diagnostic, owner, input.config);
              diagnostics.set(owner, diagnostic);
            }
            if (input.plan.steps.includes('compose-up') && !(await input.compose.health(input.config)).healthy) throw new TypeError('Workshop container is not healthy');
            break;
          case 'write-receipt':
            break;
        }
        completed.add(step);
        state = { ...state, completed: [...completed], quarantined: false };
        await atomicWrite(statePath, state);
        if (input.interruptAfter === step) throw new Error(`test interruption after ${step}`);
      } catch (error) {
        state = {
          ...state,
          completed: [...completed],
          quarantined: true,
          issue: { code: 'operation_failed', phase: step, remediation: 'Correct the reported owner/Compose condition and resume the same digest-bound plan.' },
        };
        await atomicWrite(statePath, state);
        throw error;
      }
    }
    if (!input.plan.steps.includes('write-receipt')) {
      throw new TypeError('Migration-only plan completed without an installation receipt');
    }
    credential ??= {
      credentialId: input.config.authentication.credentialId,
      credentialDigest: (await inspectProtectedCredential(input.config.authentication.tokenFile)).credentialDigest,
      protectedFile: input.config.authentication.tokenFile,
      requiredEnvironmentSelector: 'GNOLITH_BEARER_TOKEN',
    };
    const finalDiagnostics = await Promise.all(OWNER_ORDER.map((owner) => input.ports[owner].diagnose()));
    for (let index = 0; index < OWNER_ORDER.length; index++) {
      assertOwnerDiagnostic(finalDiagnostics[index]!, OWNER_ORDER[index]!, input.config);
    }
    const receipt: InstallationReceipt = {
      format: 'gnolith-seedbed-install-receipt-v1',
      operationId: input.plan.operationId,
      configDigest: input.plan.configDigest,
      endpoint: `http://127.0.0.1:${input.config.compose.workshopPort}/mcp`,
      expectedInstallationId: input.config.installationId,
      expectedBaseIri: input.config.baseIri,
      packageVersions: Object.fromEntries(finalDiagnostics.map((entry) => [entry.owner, entry.packageVersion])) as InstallationReceipt['packageVersions'],
      schemaVersions: Object.fromEntries(finalDiagnostics.map((entry) => [entry.owner, entry.schemaVersion])) as InstallationReceipt['schemaVersions'],
      expectedCatalogDigest: input.config.migrations.expectedCatalogDigest,
      credentialId: credential.credentialId,
      credentialDigest: credential.credentialDigest,
      protectedTokenFile: credential.protectedFile,
      requiredEnvironmentSelector: 'GNOLITH_BEARER_TOKEN',
      clientVerified: false,
    };
    await atomicWrite(join(input.config.paths.stateDirectory, 'installation-receipt.json'), receipt);
    return receipt;
  } finally {
    await lock.release();
  }
}

function assertOwnerDiagnostic(
  diagnostic: OwnerDiagnostic,
  owner: typeof OWNER_ORDER[number],
  config: SeedbedConfig,
): void {
  if (
    diagnostic.owner !== owner
    || !diagnostic.ready
    || diagnostic.schemaVersion !== config.migrations[owner]
    || diagnostic.packageVersion !== config.packages[owner].version
    || !/^[0-9a-f]{64}$/u.test(diagnostic.migrationDigest)
    || diagnostic.ledger.namespace !== OWNER_LEDGER_NAMESPACES[owner]
    || diagnostic.ledger.schemaVersion !== diagnostic.schemaVersion
    || !/^[0-9a-f]{64}$/u.test(diagnostic.ledger.digest)
  ) throw new TypeError(`${owner} is not at the expected package, owner migration, or namespace ledger`);
}

export async function applyMigrationPlan(input: Omit<Parameters<typeof applyInstallationPlan>[0], 'plan'> & { plan: InstallationPlan }): Promise<readonly OwnerDiagnostic[]> {
  await applyInstallationPlan(input).catch((error) => {
    if (error instanceof TypeError && error.message.includes('without an installation receipt')) return undefined;
    throw error;
  });
  return Promise.all(OWNER_ORDER.map((owner) => input.ports[owner].diagnose()));
}

function assertPlan(config: SeedbedConfig, plan: InstallationPlan): void {
  const expected = plan.steps.includes('write-receipt') ? createInstallationPlan(config) : createMigrationPlan(config);
  if (canonicalJson(plan) !== canonicalJson(expected)) throw new TypeError('Plan does not match the current configuration digest');
}

async function readState(path: string, plan: InstallationPlan): Promise<OperationState> {
  try {
    const state = JSON.parse(await readFile(path, 'utf8')) as OperationState;
    if (state.format !== 'gnolith-seedbed-operation-state-v1' || state.operationId !== plan.operationId || state.configDigest !== plan.configDigest) throw new TypeError('Operation state does not match plan');
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { format: 'gnolith-seedbed-operation-state-v1', operationId: plan.operationId, configDigest: plan.configDigest, completed: [], quarantined: false };
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${canonicalJson(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

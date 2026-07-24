import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { canonicalJson, digestObject } from './canonical.js';
import { validateConfig } from './config.js';
import { diagnoseInstallation } from './diagnostics.js';
import { applyInstallationPlan, createInstallationPlan } from './migration.js';
import { createOperatorOwnerPorts } from './owner-ports.js';
import { DockerComposeDriver, DockerDiagnosticHost } from './system-drivers.js';
import type { ImmutableCoordinate, SeedbedConfig } from './types.js';

export interface InstallationSelector {
  readonly installationId: string;
  readonly projectRoot: string;
}

export interface ExpectedWorkshopStatus {
  readonly installationId: string;
  readonly baseIri: string;
  readonly serverVersion: string;
  readonly operationVersion: string;
  readonly catalogDigest: string;
  readonly migrationReady: boolean;
  readonly canonicalReady: boolean;
  readonly authorizationReady: boolean;
  readonly lexicalReady: boolean;
  readonly blobReady: boolean;
  readonly producerStatus: 'ready' | 'degraded' | 'absent';
  readonly semanticState: 'ready' | 'degraded' | 'absent';
  readonly allowLexicalOnly: boolean;
}

export interface DockerInstallationRequest {
  readonly installationId: string;
  readonly baseIri: string;
  readonly endpoint: string;
  /** Must equal the policy's local-build selector; it is never pulled. */
  readonly image: string;
  readonly expected: ExpectedWorkshopStatus;
}

export interface SeedbedControlPlan {
  readonly id: string;
  readonly digest: string;
  readonly version: string;
  readonly request: DockerInstallationRequest;
  readonly steps: readonly string[];
  readonly stateRoot: {
    readonly kind: 'external-directory';
    readonly canonicalPath: string;
  };
}

export interface SeedbedControlReceipt {
  readonly operationId: string;
  readonly state: 'applying' | 'failed' | 'ready';
  readonly version: string;
  readonly digest: string;
  readonly endpoint: string;
  readonly installationId: string;
  readonly baseIri: string;
  readonly expected: ExpectedWorkshopStatus;
  readonly protectedTokenFile: {
    readonly kind: 'protected-file';
    readonly canonicalPath: string;
    readonly credentialId: string;
    readonly sha256: string;
  };
  readonly environmentSelector: 'GNOLITH_BEARER_TOKEN';
}

export type InstallationPlan = SeedbedControlPlan;
export type InstallationReceipt = SeedbedControlReceipt;

export interface InstallationInspection {
  readonly found: boolean;
  readonly installationId: string | null;
  readonly state: string;
}

export interface InstallationDiagnosis {
  readonly installationId: string;
  readonly classification: string;
  readonly restartAllowed: boolean;
}

export interface SeedbedControl {
  inspect(request: InstallationSelector): Promise<InstallationInspection>;
  plan(request: DockerInstallationRequest): Promise<SeedbedControlPlan>;
  apply(plan: SeedbedControlPlan): Promise<SeedbedControlReceipt>;
  resume(operationId: string): Promise<SeedbedControlReceipt>;
  diagnose(request: InstallationSelector): Promise<InstallationDiagnosis>;
}

export interface SeedbedControlPolicy {
  readonly format: 'gnolith-seedbed-control-policy-v1';
  readonly stateRoot: string;
  readonly artifactRoot: string;
  readonly localBuildSelector: string;
  readonly packages: {
    readonly diamond: ImmutableCoordinate;
    readonly taproot: ImmutableCoordinate;
    readonly workshop: ImmutableCoordinate;
    readonly waystone?: ImmutableCoordinate;
  };
  readonly compose: {
    readonly nodeImage: string;
    readonly profiles: readonly ('qdrant' | 'ollama' | 'waystone')[];
    readonly publishIpv6Loopback: boolean;
    readonly qdrantImage?: string;
    readonly ollamaImage?: string;
  };
  readonly migrations: {
    readonly diamond: string;
    readonly taproot: string;
    readonly workshop: string;
    readonly expectedCatalogDigest: string;
  };
  readonly backup: {
    readonly maxArchiveBytes: number;
    readonly maxBlobBytes: number;
    readonly retain: number;
  };
}

export interface DefaultSeedbedControlOptions {
  readonly projectRoot: string;
  readonly stateRoot?: string;
  readonly artifactRoot?: string;
}

interface OperationRecord {
  readonly format: 'gnolith-seedbed-control-operation-v1';
  readonly plan: SeedbedControlPlan;
}

export class SeedbedLocalControl implements SeedbedControl {
  readonly policy: SeedbedControlPolicy;
  private readonly attestedProjectRoot: string | undefined;

  constructor(policy: SeedbedControlPolicy, options: { attestedProjectRoot?: string } = {}) {
    if (policy.format !== 'gnolith-seedbed-control-policy-v1') throw new TypeError('Unsupported Seedbed control policy');
    if (!isAbsolute(policy.stateRoot) || /^\\\\/u.test(policy.stateRoot)) throw new TypeError('Seedbed control state root must be an absolute local path');
    if (!isAbsolute(policy.artifactRoot) || /^\\\\/u.test(policy.artifactRoot)) throw new TypeError('Seedbed artifact root must be an absolute local path');
    if (!policy.localBuildSelector || policy.localBuildSelector.length > 256) throw new TypeError('Seedbed local-build selector is invalid');
    const projectRoot = canonicalExistingDirectory(options.attestedProjectRoot ?? process.cwd(), 'project root');
    const stateRoot = canonicalProspectiveDirectory(policy.stateRoot, 'state root');
    const artifactRoot = canonicalExistingDirectory(policy.artifactRoot, 'artifact root');
    assertOutsideProjectWorktrees(stateRoot, projectRoot);
    this.policy = deepFreeze(canonicalClone({
      ...policy,
      stateRoot,
      artifactRoot,
    }));
    this.attestedProjectRoot = options.attestedProjectRoot === undefined ? undefined : projectRoot;
    this.config({
      installationId: 'seedbed-policy-validation',
      baseIri: 'https://validation.invalid/installation/',
      endpoint: 'http://127.0.0.1:4317/mcp',
      image: this.policy.localBuildSelector,
      expected: {
        installationId: 'seedbed-policy-validation',
        baseIri: 'https://validation.invalid/installation/',
        serverVersion: this.policy.packages.workshop.version,
        operationVersion: this.policy.migrations.workshop,
        catalogDigest: this.policy.migrations.expectedCatalogDigest,
        migrationReady: true,
        canonicalReady: true,
        authorizationReady: true,
        lexicalReady: true,
        blobReady: true,
        producerStatus: 'absent',
        semanticState: 'absent',
        allowLexicalOnly: true,
      },
    }, this.attestedProjectRoot ?? process.cwd());
  }

  async inspect(selector: InstallationSelector): Promise<InstallationInspection> {
    this.assertSelector(selector);
    const state = await this.readControlState(selector.installationId);
    if (state === undefined) return { found: false, installationId: null, state: 'absent' };
    return { found: true, installationId: selector.installationId, state };
  }

  async plan(request: DockerInstallationRequest): Promise<SeedbedControlPlan> {
    const internal = createInstallationPlan(this.config(request));
    const body = {
      version: 'gnolith-seedbed-control-plan-v1',
      request: canonicalClone(request),
      steps: internal.steps,
      internalPlanDigest: digestObject(internal),
      policyDigest: digestObject(this.policy),
    };
    const digest = digestObject(body);
    return {
      id: digest,
      digest,
      version: body.version,
      request: body.request,
      steps: body.steps,
      stateRoot: { kind: 'external-directory', canonicalPath: this.policy.stateRoot },
    };
  }

  async apply(plan: SeedbedControlPlan): Promise<SeedbedControlReceipt> {
    const expected = await this.plan(plan.request);
    if (canonicalJson(plan) !== canonicalJson(expected)) throw new TypeError('Seedbed control plan is stale or does not match the immutable policy');
    const config = this.config(plan.request);
    const internal = createInstallationPlan(config);
    const operationPath = this.operationPath(plan.id);
    await atomicCreateOrVerify(operationPath, { format: 'gnolith-seedbed-control-operation-v1', plan } satisfies OperationRecord);
    await this.writeControlState(plan.request.installationId, 'applying');
    try {
      const compose = new DockerComposeDriver(this.policy.artifactRoot);
      const receipt = await applyInstallationPlan({
        config,
        plan: internal,
        ports: createOperatorOwnerPorts(config, compose),
        compose,
      });
      const result: SeedbedControlReceipt = {
        operationId: plan.id,
        state: 'ready',
        version: '0.4.0',
        digest: plan.digest,
        endpoint: receipt.endpoint,
        installationId: receipt.expectedInstallationId,
        baseIri: receipt.expectedBaseIri,
        expected: plan.request.expected,
        protectedTokenFile: {
          kind: 'protected-file',
          canonicalPath: receipt.protectedTokenFile,
          credentialId: receipt.credentialId,
          sha256: receipt.credentialDigest,
        },
        environmentSelector: 'GNOLITH_BEARER_TOKEN',
      };
      await this.writeControlState(plan.request.installationId, 'ready');
      return result;
    } catch (error) {
      await this.writeControlState(plan.request.installationId, 'failed');
      throw error;
    }
  }

  async resume(operationId: string): Promise<SeedbedControlReceipt> {
    if (!/^[0-9a-f]{64}$/u.test(operationId)) throw new TypeError('Seedbed operation ID is invalid');
    const record = await readJson(this.operationPath(operationId)) as OperationRecord;
    if (record.format !== 'gnolith-seedbed-control-operation-v1' || record.plan.id !== operationId) throw new TypeError('Seedbed operation record is invalid');
    return this.apply(record.plan);
  }

  async diagnose(selector: InstallationSelector): Promise<InstallationDiagnosis> {
    this.assertSelector(selector);
    const controlState = await this.readControlState(selector.installationId);
    if (controlState === undefined) return { installationId: selector.installationId, classification: 'not-installed', restartAllowed: false };
    const record = await this.findOperation(selector.installationId);
    if (record === undefined) return { installationId: selector.installationId, classification: 'operation-record-missing', restartAllowed: false };
    const config = this.config(record.plan.request, selector.projectRoot);
    const compose = new DockerComposeDriver(this.policy.artifactRoot);
    const report = await diagnoseInstallation({
      config,
      ports: createOperatorOwnerPorts(config, compose),
      compose,
      host: new DockerDiagnosticHost(),
      artifactRoot: this.policy.artifactRoot,
    });
    const ready = report.compose.healthy && report.owners.every((owner) => owner.ready) && report.issues.length === 0;
    return {
      installationId: selector.installationId,
      classification: ready ? 'ready' : `local-installation-${controlState}`,
      restartAllowed: controlState !== 'applying',
    };
  }

  private config(request: DockerInstallationRequest, projectRoot = process.cwd()): SeedbedConfig {
    assertRequest(request, this.policy);
    const key = digestObject(request.installationId).slice(0, 24);
    const root = join(this.policy.stateRoot, 'installations', key);
    const endpoint = new URL(request.endpoint);
    const workshopPort = Number(endpoint.port);
    const qdrant = this.policy.compose.profiles.includes('qdrant');
    const ollama = this.policy.compose.profiles.includes('ollama');
    return validateConfig({
      formatVersion: 1,
      installationId: request.installationId,
      baseIri: request.baseIri,
      packages: this.policy.packages,
      compose: {
        projectName: `gnolith-${key}`,
        workshopPort,
        publishIpv6Loopback: this.policy.compose.publishIpv6Loopback,
        profiles: this.policy.compose.profiles,
        networkName: `gnolith-${key}`,
        dataVolume: `gnolith-${key}-data`,
        ...(qdrant ? { qdrantVolume: `gnolith-${key}-qdrant`, qdrantImage: this.policy.compose.qdrantImage } : {}),
        nodeImage: this.policy.compose.nodeImage,
        ...(ollama ? { ollamaImage: this.policy.compose.ollamaImage } : {}),
      },
      paths: {
        stateDirectory: root,
        dataDirectory: join(root, 'data'),
        backupDirectory: join(root, 'backups'),
      },
      authentication: {
        mode: 'local-bearer-v1',
        credentialId: `local-${key}`,
        tokenFile: join(root, 'secrets', 'bearer'),
      },
      endpoints: {},
      migrations: {
        ...this.policy.migrations,
      },
      backup: this.policy.backup,
    }, { projectDirectory: resolve(projectRoot) });
  }

  private assertSelector(selector: InstallationSelector): void {
    if (!selector.installationId || selector.installationId.length > 128 || !isAbsolute(selector.projectRoot)) throw new TypeError('Installation selector is invalid');
    const project = canonicalExistingDirectory(selector.projectRoot, 'installation selector project root');
    if (this.attestedProjectRoot !== undefined && project !== this.attestedProjectRoot) throw new TypeError('Installation selector project root does not match the attested default-control root');
    const state = this.policy.stateRoot;
    assertOutsideProjectWorktrees(state, project);
  }

  private operationPath(operationId: string): string {
    return join(this.policy.stateRoot, 'control', 'operations', `${operationId}.json`);
  }

  private async writeControlState(installationId: string, state: string): Promise<void> {
    const path = join(this.policy.stateRoot, 'control', 'installations', `${digestObject(installationId)}.json`);
    await atomicReplace(path, { format: 'gnolith-seedbed-control-state-v1', installationId, state });
  }

  private async readControlState(installationId: string): Promise<string | undefined> {
    const path = join(this.policy.stateRoot, 'control', 'installations', `${digestObject(installationId)}.json`);
    try {
      const record = await readJson(path) as { format?: string; installationId?: string; state?: string };
      if (record.format !== 'gnolith-seedbed-control-state-v1' || record.installationId !== installationId || typeof record.state !== 'string') throw new TypeError('Seedbed control state is invalid');
      return record.state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async findOperation(installationId: string): Promise<OperationRecord | undefined> {
    const directory = join(this.policy.stateRoot, 'control', 'operations');
    const { readdir } = await import('node:fs/promises');
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    for (const entry of entries.sort()) {
      if (!/^[0-9a-f]{64}\.json$/u.test(entry)) continue;
      const record = await readJson(join(directory, entry)) as OperationRecord;
      if (record.format === 'gnolith-seedbed-control-operation-v1' && record.plan.request.installationId === installationId) return record;
    }
    return undefined;
  }
}

export function createSeedbedControl(policy: SeedbedControlPolicy): SeedbedControl {
  return new SeedbedLocalControl(policy);
}

export function defaultSeedbedControlPolicy(options: DefaultSeedbedControlOptions): SeedbedControlPolicy {
  for (const [label, path] of Object.entries(options)) {
    if (path === undefined) continue;
    if (!isAbsolute(path) || /^\\\\/u.test(path)) throw new TypeError(`${label} must be an absolute local path`);
  }
  const artifactRoot = normalize(options.artifactRoot ?? defaultSeedbedArtifactRoot());
  const stateRoot = normalize(options.stateRoot ?? defaultSeedbedStateRoot());
  const lockPath = join(artifactRoot, 'seedbed-component-lock.json');
  const metadata = lstatSync(lockPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) throw new TypeError('Seedbed component lock must be a bounded regular non-link file');
  const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Seedbed component lock must be an object');
  const lock = parsed as Record<string, unknown>;
  const expectedKeys = ['format', 'localBuildSelector', 'packages', 'compose', 'migrations', 'backup'];
  if (canonicalJson(Object.keys(lock).sort()) !== canonicalJson(expectedKeys.sort()) || lock.format !== 'gnolith-seedbed-component-lock-v1') {
    throw new TypeError('Seedbed component lock has unsupported or unknown fields');
  }
  return {
    ...(canonicalClone(lock) as Omit<SeedbedControlPolicy, 'format' | 'stateRoot' | 'artifactRoot'>),
    format: 'gnolith-seedbed-control-policy-v1',
    stateRoot,
    artifactRoot,
  };
}

export function createDefaultSeedbedControl(options: DefaultSeedbedControlOptions): SeedbedControl {
  return new SeedbedLocalControl(defaultSeedbedControlPolicy(options), { attestedProjectRoot: options.projectRoot });
}

export function defaultSeedbedArtifactRoot(): string {
  return normalize(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}

export function defaultSeedbedStateRoot(): string {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    return normalize(resolve(local && isAbsolute(local) ? local : join(homedir(), 'AppData', 'Local'), 'Gnolith', 'Seedbed'));
  }
  const xdg = process.env.XDG_STATE_HOME;
  return normalize(resolve(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.local', 'state'), 'gnolith', 'seedbed'));
}

function assertRequest(request: DockerInstallationRequest, policy: SeedbedControlPolicy): void {
  if (request.image !== policy.localBuildSelector) throw new TypeError('Docker installation request must select Seedbed local-build plumbing; published application images are unsupported');
  if (request.installationId !== request.expected.installationId || request.baseIri !== request.expected.baseIri) throw new TypeError('Expected Workshop identity does not match installation request');
  if (
    request.expected.serverVersion !== policy.packages.workshop.version
    || request.expected.operationVersion !== policy.migrations.workshop
    || request.expected.catalogDigest !== policy.migrations.expectedCatalogDigest
  ) throw new TypeError('Expected Workshop versions or catalog do not match immutable Seedbed policy');
  if (!request.expected.migrationReady || !request.expected.canonicalReady || !request.expected.authorizationReady || !request.expected.lexicalReady || !request.expected.blobReady) throw new TypeError('Local installation request must expect required Workshop readiness');
  const endpoint = new URL(request.endpoint);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/mcp' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new TypeError('Seedbed local endpoint must be credential-free host IPv4 loopback /mcp');
  }
  const port = Number(endpoint.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Seedbed local endpoint must include an explicit port');
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function canonicalExistingDirectory(path: string, label: string): string {
  const normalized = normalize(resolve(path));
  const metadata = lstatSync(normalized);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new TypeError(`${label} must be a real local directory`);
  const canonical = normalize(realpathSync(normalized));
  if (!samePath(normalized, canonical)) throw new TypeError(`${label} must not use a symlink, junction, or path alias`);
  return canonical;
}

function canonicalProspectiveDirectory(path: string, label: string): string {
  const normalized = normalize(resolve(path));
  const missing: string[] = [];
  let cursor = normalized;
  while (true) {
    try {
      const metadata = lstatSync(cursor);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new TypeError(`${label} must resolve beneath a real local directory`);
      const canonicalParent = normalize(realpathSync(cursor));
      if (!samePath(cursor, canonicalParent)) throw new TypeError(`${label} must not use a symlink, junction, or path alias`);
      const canonical = normalize(join(canonicalParent, ...missing.reverse()));
      if (!samePath(normalized, canonical)) throw new TypeError(`${label} must not use a symlink, junction, or path alias`);
      return canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.push(basename(cursor));
      const parent = dirname(cursor);
      if (parent === cursor) throw new TypeError(`${label} has no existing local root`);
      cursor = parent;
    }
  }
}

function isWithin(path: string, parent: string): boolean {
  const child = normalize(path);
  const root = normalize(parent);
  if (samePath(child, root)) return true;
  return process.platform === 'win32'
    ? child.toLowerCase().startsWith(`${root.toLowerCase()}\\`)
    : child.startsWith(`${root}/`);
}

function assertOutsideProjectWorktrees(stateRoot: string, projectRoot: string): void {
  const roots = new Set<string>([projectRoot]);
  let output = '';
  try {
    output = execFileSync('git', ['-C', projectRoot, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // A non-Git project has no associated Git worktrees beyond its attested root.
  }
  for (const line of output.split(/\r?\n/u)) {
    if (!line.startsWith('worktree ')) continue;
    roots.add(canonicalExistingDirectory(line.slice('worktree '.length), 'associated worktree'));
  }
  if ([...roots].some((root) => isWithin(stateRoot, root))) throw new TypeError('Seedbed state root must remain outside the project and every associated worktree');
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function atomicCreateOrVerify(path: string, value: unknown): Promise<void> {
  const encoded = `${canonicalJson(value)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (await readFile(path, 'utf8') !== encoded) throw new TypeError('Seedbed operation ID collides with different immutable content');
  }
}

async function atomicReplace(path: string, value: unknown): Promise<void> {
  const { rename } = await import('node:fs/promises');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${canonicalJson(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { assertLowerSha256, canonicalJson, digestObject, sha256 } from './canonical.js';
import { validateConfig } from './config.js';
import { diagnoseInstallation } from './diagnostics.js';
import { applyInstallationPlan, createInstallationPlan } from './migration.js';
import { createOperatorOwnerPorts } from './owner-ports.js';
import { semanticConfigurationFingerprint } from './semantic.js';
import { decodeCanonicalTextSecret } from './secrets.js';
import { DockerComposeDriver, DockerDiagnosticHost, SeedbedOperationAbortedError } from './system-drivers.js';
import type {
  ImmutableCoordinate,
  SeedbedConfig,
  SeedbedSemanticConfigurationV1,
  SemanticConfigurationReceiptV1,
} from './types.js';

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

export const SEEDBED_LOCAL_BUILD_SELECTOR = 'gnolith-seedbed-local-build-v1' as const;

export interface SeedbedLocalBuildSelection {
  readonly kind: 'seedbed-local-build-v1';
  readonly selector: typeof SEEDBED_LOCAL_BUILD_SELECTOR;
  /** A Seedbed local build is assembled from the pinned package archives and is never pulled. */
  readonly pullPolicy: 'never';
  readonly componentLockSha256: string;
  readonly graphSha256: string;
  readonly composeBundleSha256: string;
}

export interface DigestQualifiedPulledImageSelection {
  readonly kind: 'digest-qualified-pulled-image-v1';
  /** Exact OCI reference in the form repository@sha256:<64 lowercase hex>. */
  readonly reference: string;
  readonly pullPolicy: 'digest-only';
}

export type DockerImageSelection = SeedbedLocalBuildSelection | DigestQualifiedPulledImageSelection;

export interface DockerInstallationRequest {
  readonly installationId: string;
  readonly baseIri: string;
  readonly endpoint: string;
  /**
   * Architecture-reset Seedbed accepts only the exact attested local build.
   * The discriminated union prevents a local selector from being mistaken for
   * a pulled OCI image; digest-qualified pulled images remain unsupported.
   */
  readonly image: DockerImageSelection;
  readonly expected: ExpectedWorkshopStatus;
  readonly semantic?: SeedbedSemanticConfigurationV1;
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
  readonly waystone?: WaystoneLocalExpectation;
}

export interface WaystoneLocalExpectation {
  readonly enabled: true;
  readonly prefix: '/app';
  readonly manifestSha256: string;
  readonly entrypoint: {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly mediaType: string;
  };
  readonly reservedPaths: readonly ['/', '/mcp', '/health/live', '/health/ready'];
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
  readonly semantic?: SemanticConfigurationReceiptV1;
  readonly waystone?: WaystoneLocalExpectation;
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
  readonly repair?: {
    readonly kind: 'seedbed-resume-operation-v1';
    readonly operationId: string;
    readonly action: 'restart-recorded-compose';
  };
}

export interface SeedbedControlOperationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface SeedbedControl {
  inspect(request: InstallationSelector, options?: SeedbedControlOperationOptions): Promise<InstallationInspection>;
  plan(request: DockerInstallationRequest, options?: SeedbedControlOperationOptions): Promise<SeedbedControlPlan>;
  apply(plan: SeedbedControlPlan, options?: SeedbedControlOperationOptions): Promise<SeedbedControlReceipt>;
  resume(operationId: string, options?: SeedbedControlOperationOptions): Promise<SeedbedControlReceipt>;
  diagnose(request: InstallationSelector, options?: SeedbedControlOperationOptions): Promise<InstallationDiagnosis>;
}

export interface SeedbedControlPolicy {
  readonly format: 'gnolith-seedbed-control-policy-v2';
  readonly stateRoot: string;
  readonly artifactRoot: string;
  readonly localBuild: SeedbedLocalBuildSelection;
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
    if (policy.format !== 'gnolith-seedbed-control-policy-v2') throw new TypeError('Unsupported Seedbed control policy');
    if (!isAbsolute(policy.stateRoot) || /^\\\\/u.test(policy.stateRoot)) throw new TypeError('Seedbed control state root must be an absolute local path');
    if (!isAbsolute(policy.artifactRoot) || /^\\\\/u.test(policy.artifactRoot)) throw new TypeError('Seedbed artifact root must be an absolute local path');
    assertLocalBuildSelection(policy.localBuild);
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
    if (!this.policy.compose.profiles.includes('qdrant') && !this.policy.compose.profiles.includes('ollama')) this.config({
      installationId: 'seedbed-policy-validation',
      baseIri: 'https://validation.invalid/installation',
      endpoint: 'http://127.0.0.1:4317/mcp',
      image: this.policy.localBuild,
      expected: {
        installationId: 'seedbed-policy-validation',
        baseIri: 'https://validation.invalid/installation',
        serverVersion: this.policy.packages.workshop.version,
        operationVersion: this.policy.migrations.workshop,
        catalogDigest: this.policy.migrations.expectedCatalogDigest,
        migrationReady: true,
        canonicalReady: true,
        authorizationReady: true,
        lexicalReady: true,
        blobReady: true,
        producerStatus: 'ready',
        semanticState: 'absent',
        allowLexicalOnly: true,
      },
    }, this.attestedProjectRoot ?? process.cwd());
  }

  async inspect(selector: InstallationSelector, options: SeedbedControlOperationOptions = {}): Promise<InstallationInspection> {
    assertOperationOptions(options);
    throwIfAborted(options.signal);
    this.assertSelector(selector);
    const state = await this.readControlState(selector.installationId);
    if (state === undefined) return { found: false, installationId: null, state: 'absent' };
    return { found: true, installationId: selector.installationId, state };
  }

  async plan(request: DockerInstallationRequest, options: SeedbedControlOperationOptions = {}): Promise<SeedbedControlPlan> {
    assertOperationOptions(options);
    throwIfAborted(options.signal);
    const config = this.config(request);
    const canonicalRequest: DockerInstallationRequest = request.semantic === undefined
      ? request
      : { ...request, semantic: config.semantic! };
    const internal = createInstallationPlan(config);
    const waystone = await waystoneExpectation(this.policy);
    const body = {
      version: 'gnolith-seedbed-control-plan-v2',
      request: canonicalClone(canonicalRequest),
      steps: internal.steps,
      internalPlanDigest: digestObject(internal),
      policyDigest: digestObject(this.policy),
      ...(waystone === undefined ? {} : { waystone }),
    };
    const digest = digestObject(body);
    return {
      id: digest,
      digest,
      version: body.version,
      request: body.request,
      steps: body.steps,
      stateRoot: { kind: 'external-directory', canonicalPath: this.policy.stateRoot },
      ...(waystone === undefined ? {} : { waystone }),
    };
  }

  async apply(plan: SeedbedControlPlan, options: SeedbedControlOperationOptions = {}): Promise<SeedbedControlReceipt> {
    const execution = boundedExecution(options, 10 * 60_000);
    const expected = await this.plan(plan.request, execution);
    if (canonicalJson(plan) !== canonicalJson(expected)) throw new TypeError('Seedbed control plan is stale or does not match the immutable policy');
    const config = this.config(plan.request);
    const internal = createInstallationPlan(config);
    const operationPath = this.operationPath(plan.id);
    await atomicCreateOrVerify(operationPath, { format: 'gnolith-seedbed-control-operation-v1', plan } satisfies OperationRecord);
    await this.writeControlState(plan.request.installationId, 'applying');
    try {
      const compose = new DockerComposeDriver(this.policy.artifactRoot, execution);
      const receipt = await applyInstallationPlan({
        config,
        plan: internal,
        ports: createOperatorOwnerPorts(config, compose),
        compose,
      });
      if (!(await compose.health(config)).healthy) await compose.up(config);
      await verifyExpectedWorkshopReadiness(plan.request, receipt.protectedTokenFile);
      if (plan.waystone !== undefined) {
        await verifyExpectedWaystone(plan.request, receipt.protectedTokenFile, plan.waystone);
      }
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
        ...(receipt.semantic === undefined ? {} : { semantic: receipt.semantic }),
        ...(plan.waystone === undefined ? {} : { waystone: plan.waystone }),
      };
      await this.writeControlState(plan.request.installationId, 'ready');
      return result;
    } catch (error) {
      await this.writeControlState(plan.request.installationId, 'failed');
      throw error;
    }
  }

  async resume(operationId: string, options: SeedbedControlOperationOptions = {}): Promise<SeedbedControlReceipt> {
    const execution = boundedExecution(options, 60_000);
    if (!/^[0-9a-f]{64}$/u.test(operationId)) throw new TypeError('Seedbed operation ID is invalid');
    const record = await readJson(this.operationPath(operationId)) as OperationRecord;
    if (record.format !== 'gnolith-seedbed-control-operation-v1' || record.plan.id !== operationId) throw new TypeError('Seedbed operation record is invalid');
    return this.apply(record.plan, execution);
  }

  async diagnose(selector: InstallationSelector, options: SeedbedControlOperationOptions = {}): Promise<InstallationDiagnosis> {
    const execution = boundedExecution(options, 9_000);
    this.assertSelector(selector);
    const controlState = await this.readControlState(selector.installationId);
    if (controlState === undefined) return { installationId: selector.installationId, classification: 'not-installed', restartAllowed: false };
    const record = await this.findOperation(selector.installationId);
    if (record === undefined) return { installationId: selector.installationId, classification: 'operation-record-missing', restartAllowed: false };
    const config = this.config(record.plan.request, selector.projectRoot);
    const compose = new DockerComposeDriver(this.policy.artifactRoot, execution);
    const report = await diagnoseInstallation({
      config,
      ports: createOperatorOwnerPorts(config, compose),
      compose,
      host: new DockerDiagnosticHost(),
      artifactRoot: this.policy.artifactRoot,
    });
    const authenticatedReady = report.compose.healthy
      ? await verifyExpectedWorkshopReadiness(record.plan.request, config.authentication.tokenFile).then(() => true).catch(() => false)
      : false;
    const ready = report.compose.healthy && authenticatedReady && report.owners.every((owner) => owner.ready) && report.issues.length === 0;
    const ownerRuntimeTimedOut = report.issues.some((issue) => issue.code === 'owner_diagnostic_timeout');
    const repairable = !ready
      && controlState !== 'applying'
      && (report.owners.every((owner) => owner.ready) || (!report.compose.healthy && ownerRuntimeTimedOut))
      && report.artifacts.every((artifact) => artifact.digestMatches)
      && report.credential.protected;
    return {
      installationId: selector.installationId,
      classification: ready
        ? 'ready'
        : !report.compose.healthy || !authenticatedReady
          ? 'local-workshop-unavailable'
          : `local-installation-${controlState}`,
      restartAllowed: repairable,
      ...(repairable ? {
        repair: {
          kind: 'seedbed-resume-operation-v1',
          operationId: record.plan.id,
          action: 'restart-recorded-compose',
        },
      } : {}),
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
      ...(request.semantic === undefined ? {} : { semantic: request.semantic }),
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
  const lockBytes = readFileSync(lockPath);
  const parsed: unknown = JSON.parse(lockBytes.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Seedbed component lock must be an object');
  const lock = parsed as Record<string, unknown>;
  const expectedKeys = ['format', 'localBuildSelector', 'packages', 'compose', 'migrations', 'backup'];
  if (canonicalJson(Object.keys(lock).sort()) !== canonicalJson(expectedKeys.sort()) || lock.format !== 'gnolith-seedbed-component-lock-v1') {
    throw new TypeError('Seedbed component lock has unsupported or unknown fields');
  }
  const attestationPath = join(artifactRoot, 'seedbed-assembly-attestation.json');
  const attestationMetadata = lstatSync(attestationPath);
  if (!attestationMetadata.isFile() || attestationMetadata.isSymbolicLink() || attestationMetadata.size > 64 * 1024) {
    throw new TypeError('Seedbed assembly attestation must be a bounded regular non-link file');
  }
  const attestation: unknown = JSON.parse(readFileSync(attestationPath, 'utf8'));
  assertLocalBuildSelection(attestation);
  if (attestation.componentLockSha256 !== sha256(lockBytes)) throw new TypeError('Seedbed assembly attestation does not match the component lock');
  if (lock.localBuildSelector !== attestation.selector) throw new TypeError('Seedbed component lock and assembly selector differ');
  const { localBuildSelector: _localBuildSelector, ...policyLock } = lock;
  return {
    ...(canonicalClone(policyLock) as Omit<SeedbedControlPolicy, 'format' | 'stateRoot' | 'artifactRoot' | 'localBuild'>),
    format: 'gnolith-seedbed-control-policy-v2',
    stateRoot,
    artifactRoot,
    localBuild: canonicalClone(attestation),
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

function assertLocalBuildSelection(value: unknown): asserts value is SeedbedLocalBuildSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Seedbed local-build selection must be an object');
  const selection = value as Record<string, unknown>;
  const expectedKeys = ['kind', 'selector', 'pullPolicy', 'componentLockSha256', 'graphSha256', 'composeBundleSha256'];
  if (canonicalJson(Object.keys(selection).sort()) !== canonicalJson(expectedKeys.sort())) {
    throw new TypeError('Seedbed local-build selection has unsupported or missing fields');
  }
  if (
    selection.kind !== 'seedbed-local-build-v1'
    || selection.selector !== SEEDBED_LOCAL_BUILD_SELECTOR
    || selection.pullPolicy !== 'never'
  ) throw new TypeError('Seedbed local-build selector or pull policy is invalid');
  assertLowerSha256(selection.componentLockSha256, 'Seedbed component-lock attestation');
  assertLowerSha256(selection.graphSha256, 'Seedbed graph attestation');
  assertLowerSha256(selection.composeBundleSha256, 'Seedbed Compose-bundle attestation');
}

function assertRequest(request: DockerInstallationRequest, policy: SeedbedControlPolicy): void {
  if (request.image?.kind === 'digest-qualified-pulled-image-v1') {
    if (!/^[A-Za-z0-9./:_-]+@sha256:[0-9a-f]{64}$/u.test(request.image.reference) || request.image.pullPolicy !== 'digest-only') {
      throw new TypeError('Digest-qualified pulled image selection is invalid');
    }
    throw new TypeError('Digest-qualified pulled application images are unsupported; use the exact attested Seedbed local build');
  }
  assertLocalBuildSelection(request.image);
  if (canonicalJson(request.image) !== canonicalJson(policy.localBuild)) {
    throw new TypeError('Docker installation request local-build attestations do not match immutable Seedbed policy');
  }
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
  if (request.expected.producerStatus !== 'ready') {
    throw new TypeError('Local installation request must expect the bootstrapped Workshop producer registry');
  }
  if (request.semantic === undefined) {
    if (request.expected.semanticState !== 'absent' || !request.expected.allowLexicalOnly) {
      throw new TypeError('An installation without semantic configuration must explicitly expect lexical-only operation');
    }
  } else if (
    request.expected.semanticState === 'absent'
    || request.expected.allowLexicalOnly !== (request.expected.semanticState !== 'ready')
  ) {
    throw new TypeError('A digest-bound semantic installation must truthfully declare ready or degraded semantic operation');
  }
  for (const selector of request.semantic?.credentialSelectors ?? []) {
    const requestedPath = normalize(resolve(selector.path));
    let metadata;
    let canonicalPath: string;
    try {
      metadata = lstatSync(requestedPath);
      canonicalPath = normalize(realpathSync(requestedPath));
    } catch {
      throw new TypeError(`Protected semantic selector ${selector.id} must name an existing local file`);
    }
    const comparableRequested = process.platform === 'win32' ? requestedPath.toLowerCase() : requestedPath;
    const comparableCanonical = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
    if (metadata.isSymbolicLink() || !metadata.isFile() || comparableRequested !== comparableCanonical) {
      throw new TypeError(`Protected semantic selector ${selector.id} must be a direct regular file, not a symlink, junction, or alias`);
    }
    if (metadata.size < 1 || metadata.size > 1024 * 1024) {
      throw new TypeError(`Protected semantic selector ${selector.id} must contain 1..1048576 bytes`);
    }
    try {
      decodeCanonicalTextSecret(readFileSync(requestedPath), 1024 * 1024);
    } catch {
      throw new TypeError(`Protected semantic selector ${selector.id} must contain canonical text secret bytes`);
    }
  }
}

async function waystoneExpectation(policy: SeedbedControlPolicy): Promise<WaystoneLocalExpectation | undefined> {
  if (!policy.compose.profiles.includes('waystone')) return undefined;
  const coordinate = policy.packages.waystone;
  if (coordinate === undefined) throw new TypeError('Default Waystone profile lacks an immutable coordinate');
  const path = resolve(policy.artifactRoot, coordinate.artifact);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 8 * 1024 * 1024) {
    throw new TypeError('Waystone manifest must be a bounded regular non-link file');
  }
  const bytes = readFileSync(path);
  if (sha256(bytes) !== coordinate.sha256) throw new TypeError('Waystone manifest digest differs from immutable policy');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError('Waystone manifest must be bounded UTF-8 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Waystone manifest is invalid');
  const manifest = parsed as Record<string, unknown>;
  const keys = ['entrypoint', 'files', 'format', 'manifestSha256'];
  if (canonicalJson(Object.keys(manifest).sort()) !== canonicalJson(keys) || manifest.format !== 'waystone-assets-v1') {
    throw new TypeError('Waystone manifest format is invalid');
  }
  if (typeof manifest.entrypoint !== 'string' || !Array.isArray(manifest.files)) throw new TypeError('Waystone manifest entrypoint is invalid');
  const entry = manifest.files.find((candidate) => (
    candidate !== null
    && typeof candidate === 'object'
    && !Array.isArray(candidate)
    && (candidate as Record<string, unknown>).path === manifest.entrypoint
  )) as Record<string, unknown> | undefined;
  if (
    entry === undefined
    || typeof entry.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(entry.sha256)
    || !Number.isSafeInteger(entry.bytes)
    || Number(entry.bytes) < 1
    || typeof entry.mediaType !== 'string'
    || entry.mediaType.length < 1
    || entry.mediaType.length > 256
  ) throw new TypeError('Waystone manifest entrypoint declaration is invalid');
  return {
    enabled: true,
    prefix: '/app',
    manifestSha256: coordinate.sha256,
    entrypoint: {
      path: manifest.entrypoint,
      sha256: entry.sha256,
      bytes: Number(entry.bytes),
      mediaType: entry.mediaType,
    },
    reservedPaths: ['/', '/mcp', '/health/live', '/health/ready'],
  };
}

async function verifyExpectedWorkshopReadiness(request: DockerInstallationRequest, tokenFile: string): Promise<void> {
  const token = decodeCanonicalTextSecret(await readFile(tokenFile), 45);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new TypeError('Protected local bearer selector is invalid');
  const endpoint = new URL('/health/ready', request.endpoint);
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new TypeError('Workshop authenticated readiness returned invalid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Workshop authenticated readiness is invalid');
  const status = value as Record<string, unknown>;
  const versions = status.versions as Record<string, unknown> | undefined;
  const migrationReadiness = status.migrationReadiness as Record<string, unknown> | undefined;
  const producers = status.producers as Record<string, unknown> | undefined;
  const semanticState = status.semanticState as Record<string, unknown> | undefined;
  const expectedSemanticFingerprint = request.semantic === undefined
    ? null
    : semanticConfigurationFingerprint(request.semantic.configuration);
  const expectedSemanticRevision = request.semantic === undefined
    ? null
    : request.semantic.expectedRevision + 1;
  if (
    !response.ok
    || status.installationId !== request.expected.installationId
    || status.baseIri !== request.expected.baseIri
    || versions?.server !== request.expected.serverVersion
    || status.operationCatalogDigest !== request.expected.catalogDigest
    || migrationReadiness?.ready !== request.expected.migrationReady
    || status.canonicalReady !== request.expected.canonicalReady
    || status.authorizationReady !== request.expected.authorizationReady
    || status.lexicalReady !== request.expected.lexicalReady
    || status.blobReady !== request.expected.blobReady
    || producers?.ready !== true
    || semanticState?.state !== (request.semantic === undefined ? 'unconfigured' : request.expected.semanticState)
    || semanticState?.configured !== (request.semantic !== undefined)
    || semanticState?.revision !== expectedSemanticRevision
    || semanticState?.fingerprint !== expectedSemanticFingerprint
    || semanticState?.ready !== (request.expected.semanticState === 'ready')
  ) throw new TypeError('Workshop authenticated readiness does not match the immutable installation request');
}

async function verifyExpectedWaystone(
  request: DockerInstallationRequest,
  tokenFile: string,
  expectation: WaystoneLocalExpectation,
): Promise<void> {
  const token = decodeCanonicalTextSecret(await readFile(tokenFile), 45);
  const origin = new URL(request.endpoint).origin;
  for (const pathname of ['/app', '/app/', `/app/${expectation.entrypoint.path}`]) {
    const response = await fetch(new URL(pathname, origin), {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (
      !response.ok
      || response.headers.get('content-type') !== expectation.entrypoint.mediaType
      || bytes.byteLength !== expectation.entrypoint.bytes
      || sha256(bytes) !== expectation.entrypoint.sha256
    ) throw new TypeError(`Waystone default asset verification failed: ${JSON.stringify({
      pathname,
      status: response.status,
      mediaType: response.headers.get('content-type'),
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    })}`);
  }
  for (const pathname of expectation.reservedPaths) {
    const response = await fetch(new URL(pathname, origin), {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (
      response.headers.get('content-type') === expectation.entrypoint.mediaType
      || sha256(bytes) === expectation.entrypoint.sha256
    ) throw new TypeError('Waystone asset mount shadowed a reserved Workshop route');
  }
  for (const pathname of ['/app/%2e%2e%2fmcp', '/app/%2e%2e%2fhealth%2fready']) {
    const response = await fetch(`${origin}${pathname}`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) throw new TypeError('Waystone asset mount accepted encoded dot-segment traversal');
  }
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

function assertOperationOptions(options: SeedbedControlOperationOptions): void {
  if (
    options.timeoutMs !== undefined
    && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 10 * 60_000)
  ) throw new TypeError('Seedbed control timeout must be 1..600000 milliseconds');
}

function boundedExecution(options: SeedbedControlOperationOptions, defaultTimeoutMs: number): Required<SeedbedControlOperationOptions> {
  assertOperationOptions(options);
  const timeoutMs = Math.min(options.timeoutMs ?? defaultTimeoutMs, defaultTimeoutMs);
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);
  throwIfAborted(signal);
  return { signal, timeoutMs };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SeedbedOperationAbortedError('control');
}

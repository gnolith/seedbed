import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCompose, assertSafeComposeEnvironment } from './compose.js';
import type { SeedbedConfig } from './types.js';
import type { ComposeDriver } from './migration.js';
import type { DiagnosticHost, HostDiagnostics } from './diagnostics.js';
import type { AdoptionTarget, AdoptionVerification } from './adoption.js';
import type { OwnerSection } from './owner-ports.js';
import type { SeedbedOperatorExecutor } from './owner-ports.js';
import type { RestoreTarget } from './backup.js';
import { canonicalJson, sha256 } from './canonical.js';
import type { LegacyAdapterExecutor, PortableLegacySource } from './legacy-source.js';

const exec = promisify(execFile);
const SEEDBED_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const OPERATOR_OPERATIONS = new Set([
  'owner-migration-plan-v1', 'owner-migration-apply-v1', 'owner-diagnostics-v1',
  'owner-backup-inspect-v1', 'owner-backup-export-v1', 'owner-backup-validate-v1',
  'owner-backup-import-v1', 'workshop-bootstrap-v1', 'taproot-blob-enumerate-v1',
  'workshop-semantic-configure-v1',
  'taproot-blob-open-v1', 'taproot-blob-stage-v1', 'taproot-blob-collision-check-v1',
  'taproot-blob-rebind-v1', 'taproot-blob-commit-v1', 'taproot-blob-rollback-v1',
  'adoption-owner-import-v1', 'adoption-payload-stage-v1', 'adoption-payload-collision-check-v1',
  'adoption-payload-rebind-v1', 'adoption-payload-commit-v1', 'adoption-payload-rollback-v1',
  'adoption-diagnostics-v1',
  'restore-target-empty-v1', 'restore-prepare-staging-v1', 'restore-expose-database-last-v1', 'restore-cleanup-v1',
  'legacy-owner-inspect-v1', 'legacy-owner-export-v1', 'legacy-taproot-payload-open-v1',
]);

export class DockerComposeDriver implements ComposeDriver, SeedbedOperatorExecutor, LegacyAdapterExecutor {
  constructor(private readonly artifactRoot = SEEDBED_PACKAGE_ROOT) {}

  async prepare(config: SeedbedConfig): Promise<void> {
    const render = renderCompose(config);
    assertSafeComposeEnvironment(render.environment);
    const directory = join(config.paths.stateDirectory, 'compose');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertProtectedDirectory(directory);
    const build = join(directory, 'build');
    await mkdir(join(build, 'docker'), { recursive: true, mode: 0o700 });
    await assertProtectedDirectory(join(build, 'docker'));
    for (const file of [
      'local-build.Dockerfile',
      'assembly-package.json',
      'assembly-package-lock.json',
      'operator-runner.mjs',
      'workshop-local-adapter.mjs',
      'opaque-codec.mjs',
      'read-only-sql.mjs',
    ]) {
      await copyFile(join(SEEDBED_PACKAGE_ROOT, 'docker', file), join(build, 'docker', file));
    }
    for (const owner of ['diamond', 'taproot', 'workshop'] as const) {
      const coordinate = config.packages[owner];
      const source = resolve(this.artifactRoot, coordinate.artifact);
      const metadata = await lstat(source);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new TypeError(`${owner} artifact must be a regular non-link file`);
      const bytes = await readFile(source);
      if (sha256(bytes) !== coordinate.sha256) throw new TypeError(`${owner} artifact digest mismatch`);
      const destination = join(build, ...coordinate.artifact.split('/'));
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination);
    }
    if (config.compose.profiles.includes('waystone')) {
      const coordinate = config.packages.waystone;
      if (!coordinate) throw new TypeError('waystone profile requires an immutable asset manifest coordinate');
      const source = resolve(this.artifactRoot, coordinate.artifact);
      const metadata = await lstat(source);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new TypeError('waystone asset manifest must be a regular non-link file');
      if (metadata.size > 8 * 1024 * 1024) throw new TypeError('waystone asset manifest exceeds 8 MiB');
      const bytes = await readFile(source);
      if (sha256(bytes) !== coordinate.sha256) throw new TypeError('waystone asset manifest digest mismatch');
      const manifest = assertWaystoneManifest(bytes);
      const waystoneDirectory = join(directory, 'waystone');
      const destination = join(waystoneDirectory, 'waystone-assets.json');
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await stageImmutableManifest(destination, bytes, coordinate.sha256);
      const sourceDirectory = dirname(source);
      const basenames = new Set<string>();
      for (const asset of manifest.files) {
        const sourceBasename = asset.path.split('/').at(-1)!;
        if (basenames.has(sourceBasename)) throw new TypeError('waystone asset manifest contains ambiguous flattened filenames');
        basenames.add(sourceBasename);
        const nestedSource = join(sourceDirectory, ...asset.path.split('/'));
        const flattenedSource = join(sourceDirectory, sourceBasename);
        const assetSource = await access(nestedSource).then(() => nestedSource).catch(() => flattenedSource);
        const assetMetadata = await lstat(assetSource);
        if (!assetMetadata.isFile() || assetMetadata.isSymbolicLink() || assetMetadata.size !== asset.bytes) throw new TypeError(`waystone asset ${asset.path} must be an exact regular non-link file`);
        const assetBytes = await readFile(assetSource);
        if (sha256(assetBytes) !== asset.sha256) throw new TypeError(`waystone asset ${asset.path} digest mismatch`);
        const assetDestination = join(waystoneDirectory, ...asset.path.split('/'));
        await mkdir(dirname(assetDestination), { recursive: true, mode: 0o700 });
        await stageImmutableManifest(assetDestination, assetBytes, asset.sha256);
      }
    }
    const workshopConfig = {
      format: 'gnolith-workshop-config-v1',
      listener: { host: '0.0.0.0', port: 4317, profile: 'container' },
      authentication: {
        profile: 'local-bearer-v1',
        credentialStore: { kind: 'file', value: '/run/secrets/gnolith-bearer' },
      },
      adapterModule: './workshop-local-adapter.mjs',
      ...(config.compose.profiles.includes('waystone') ? {
        assetMount: {
          prefix: '/app',
          manifest: { kind: 'file', value: '/srv/waystone/waystone-assets.json' },
          root: { kind: 'file', value: '/srv/waystone' },
        },
      } : {}),
      background: { intervalMs: 30_000, timeoutMs: 30_000 },
      shutdownTimeoutMs: 30_000,
    };
    const assemblyConfig = {
      format: 'gnolith-seedbed-local-assembly-v1',
      installationId: config.installationId,
      baseIri: config.baseIri,
      databasePath: '/var/lib/gnolith/gnolith.sqlite',
      blobRoot: '/var/lib/gnolith/blobs',
      principalId: config.authentication.credentialId,
      workspaceId: 'default',
      registrationFingerprint: sha256(canonicalJson({
        installationId: config.installationId,
        packages: config.packages,
        migrations: config.migrations,
      })),
      cursorGeneration: 'seedbed-local-v1',
      maxBlobBytes: config.backup.maxBlobBytes,
      semanticCredentialFiles: Object.fromEntries(
        (config.semantic?.credentialSelectors ?? [])
          .map(({ id }): [string, string] => [id, `/run/secrets/gnolith-semantic-${sha256(id).slice(0, 16)}`])
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
    await writeFile(join(build, 'workshop.config.json'), `${canonicalJson(workshopConfig)}\n`, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(build, 'assembly.config.json'), `${canonicalJson(assemblyConfig)}\n`, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(directory, 'compose.yaml'), render.yaml, { encoding: 'utf8', mode: 0o600 });
    const env = Object.entries(render.environment).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
    await writeFile(join(directory, 'compose.env'), `${env}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  async up(config: SeedbedConfig): Promise<void> {
    const args = this.args(config);
    for (const profile of config.compose.profiles) args.push('--profile', profile);
    args.push('up', '--build', '--detach', '--wait', '--force-recreate');
    await exec('docker', args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  }

  async buildOperator(config: SeedbedConfig): Promise<void> {
    await exec('docker', [...this.args(config), 'build', 'workshop'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  }

  async invoke<T>(config: SeedbedConfig, operation: string, input: unknown): Promise<T> {
    const child = this.operatorProcess(config, operation);
    const output: Buffer[] = [];
    let bytes = 0;
    const limit = operation === 'owner-backup-export-v1'
      ? encodedResponseLimit(config.backup.maxArchiveBytes)
      : 8 * 1024 * 1024;
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > limit) child.kill();
      else output.push(chunk);
    });
    const completion = childCompletion(child, 'Seedbed Compose operator');
    child.stdin.end(`${canonicalJson({ context: operatorContext(config), input })}\n`);
    await completion;
    if (bytes > limit) throw new TypeError('Seedbed operator response exceeded configured bounds');
    return JSON.parse(Buffer.concat(output).toString('utf8')) as T;
  }

  async read(config: SeedbedConfig, operation: string, input: unknown): Promise<AsyncIterable<Uint8Array>> {
    const self = this;
    async function* stream(): AsyncIterable<Uint8Array> {
      const child = self.operatorProcess(config, operation, ['--stream-out']);
      const completion = childCompletion(child, 'Seedbed Compose streaming operator');
      child.stdin.end(`${canonicalJson({ context: operatorContext(config), input })}\n`);
      try {
        for await (const chunk of child.stdout) yield chunk as Buffer;
        await completion;
      } catch (error) {
        child.kill();
        await completion.catch(() => undefined);
        throw error;
      }
    }
    return stream();
  }

  async write(config: SeedbedConfig, operation: string, input: unknown, source: AsyncIterable<Uint8Array>): Promise<void> {
    const metadata = Buffer.from(canonicalJson({ context: operatorContext(config), input })).toString('base64url');
    if (metadata.length > 8192) throw new TypeError('Seedbed streaming operator metadata is too large');
    const child = this.operatorProcess(config, operation, ['--stream-in', metadata]);
    const completion = childCompletion(child, 'Seedbed Compose streaming operator');
    try {
      for await (const chunk of source) {
        if (!child.stdin.write(chunk)) await new Promise<void>((resolveDrain) => child.stdin.once('drain', resolveDrain));
      }
      child.stdin.end();
      await completion;
    } catch (error) {
      child.stdin.destroy();
      child.kill();
      await completion.catch(() => undefined);
      throw error;
    }
  }

  async invokeLegacy<T>(
    config: SeedbedConfig,
    operation: 'legacy-owner-inspect-v1' | 'legacy-owner-export-v1',
    source: PortableLegacySource,
    input: unknown,
  ): Promise<T> {
    const child = this.operatorProcess(config, operation, [], this.legacyMounts(source));
    const output: Buffer[] = [];
    let bytes = 0;
    const limit = encodedResponseLimit(config.backup.maxArchiveBytes);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > limit) child.kill();
      else output.push(chunk);
    });
    const completion = childCompletion(child, 'Seedbed legacy owner adapters');
    child.stdin.end(`${canonicalJson({ context: operatorContext(config), input, source: portableContainerSource() })}\n`);
    await completion;
    if (bytes > limit) throw new TypeError('Legacy owner adapter response exceeded configured bounds');
    return JSON.parse(Buffer.concat(output).toString('utf8')) as T;
  }

  async readLegacy(
    config: SeedbedConfig,
    operation: 'legacy-taproot-payload-open-v1',
    source: PortableLegacySource,
    input: unknown,
  ): Promise<AsyncIterable<Uint8Array>> {
    const self = this;
    async function* stream(): AsyncIterable<Uint8Array> {
      const child = self.operatorProcess(config, operation, ['--stream-out'], self.legacyMounts(source));
      const completion = childCompletion(child, 'Seedbed legacy Taproot payload adapter');
      child.stdin.end(`${canonicalJson({ context: operatorContext(config), input, source: portableContainerSource() })}\n`);
      try {
        for await (const chunk of child.stdout) yield chunk as Buffer;
        await completion;
      } catch (error) {
        child.kill();
        await completion.catch(() => undefined);
        throw error;
      }
    }
    return stream();
  }

  async health(config: SeedbedConfig): Promise<{ healthy: boolean }> {
    const result = await exec('docker', [...this.args(config), 'ps', '--format', 'json'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
    const services = lines.map((line) => JSON.parse(line) as { Service?: string; Health?: string; State?: string });
    const workshop = services.find((entry) => entry.Service === 'workshop');
    return { healthy: workshop?.State === 'running' && (!workshop.Health || workshop.Health === 'healthy') };
  }

  async downRetainData(config: SeedbedConfig): Promise<void> {
    await exec('docker', [...this.args(config), 'down', '--remove-orphans'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  }

  private args(config: SeedbedConfig): string[] {
    const directory = join(config.paths.stateDirectory, 'compose');
    return ['compose', '--project-name', config.compose.projectName, '--file', join(directory, 'compose.yaml'), '--env-file', join(directory, 'compose.env')];
  }

  private operatorProcess(config: SeedbedConfig, operation: string, mode: readonly string[] = [], mounts: readonly string[] = []) {
    if (!OPERATOR_OPERATIONS.has(operation)) throw new TypeError('Unsupported Seedbed operator operation');
    const secretMount = protectedOperatorMountArgs(operation, config.authentication.tokenFile);
    return spawn('docker', [
      ...this.args(config),
      '--profile', 'seedbed-operator',
      'run', '--rm', '--no-deps', '-T', ...secretMount, ...mounts, 'seedbed-operator',
      operation, ...mode,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  private legacyMounts(source: PortableLegacySource): string[] {
    return [
      '--volume', `${source.databasePath}:/seedbed-legacy/source.sqlite:ro`,
      '--volume', `${source.blobPath}:/seedbed-legacy/blobs:ro`,
    ];
  }
}

export function protectedOperatorMountArgs(operation: string, tokenFile: string): readonly string[] {
  return operation === 'workshop-bootstrap-v1' || operation === 'workshop-semantic-configure-v1'
    ? ['--volume', `${tokenFile}:/run/secrets/gnolith-bearer:ro`]
    : [];
}

export class DockerDiagnosticHost implements DiagnosticHost {
  async inspect(): Promise<HostDiagnostics> {
    const [docker, engine, compose] = await Promise.all([
      version(['--version']),
      version(['version', '--format', '{{.Server.Version}}']),
      version(['compose', 'version', '--short']),
    ]);
    return {
      dockerCli: docker,
      dockerEngine: engine,
      compose,
    };
  }

  async reachable(endpoint: string): Promise<boolean> {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
    return response.status < 500;
  }
}

export class LocalRestoreTarget implements RestoreTarget {
  constructor(protected readonly config: SeedbedConfig) {}
  async isEmpty(): Promise<boolean> {
    return stat(join(this.config.paths.dataDirectory, 'gnolith.sqlite')).then(() => false).catch(() => true);
  }
  async stagingDirectory(operationId: string): Promise<string> {
    const staging = join(this.config.paths.stateDirectory, 'staging', operationId);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    return staging;
  }
  async exposeDatabaseLast(stagingDirectory: string): Promise<void> {
    const pending = join(stagingDirectory, 'gnolith.sqlite');
    await access(pending);
    await mkdir(this.config.paths.dataDirectory, { recursive: true, mode: 0o700 });
    await rename(pending, join(this.config.paths.dataDirectory, 'gnolith.sqlite'));
    await rm(stagingDirectory, { recursive: true, force: true });
  }
  async cleanup(stagingDirectory: string): Promise<void> {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

export class ComposeRestoreTarget implements RestoreTarget {
  constructor(protected readonly config: SeedbedConfig, protected readonly executor: SeedbedOperatorExecutor) {}
  async isEmpty(): Promise<boolean> {
    const result = await this.executor.invoke<{ empty: boolean }>(this.config, 'restore-target-empty-v1', {});
    return result.empty;
  }
  async stagingDirectory(operationId: string): Promise<string> {
    if (!/^[0-9a-f]{64}$/u.test(operationId)) throw new TypeError('Restore operation ID is invalid');
    const stagingDirectory = `/var/lib/gnolith/.seedbed-staging/${operationId}`;
    await this.executor.invoke(this.config, 'restore-prepare-staging-v1', { stagingDirectory, operationId });
    return stagingDirectory;
  }
  async exposeDatabaseLast(stagingDirectory: string, operationId: string): Promise<void> {
    await this.executor.invoke(this.config, 'restore-expose-database-last-v1', { stagingDirectory, operationId });
  }
  async cleanup(stagingDirectory: string): Promise<void> {
    await this.executor.invoke(this.config, 'restore-cleanup-v1', { stagingDirectory });
  }
}

function assertWaystoneManifest(bytes: Uint8Array): { files: readonly { path: string; bytes: number; sha256: string }[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError('waystone asset manifest must be bounded UTF-8 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('waystone asset manifest must be a JSON object');
  }
  const manifest = parsed as Record<string, unknown>;
  const keys = ['format', 'entrypoint', 'files', 'manifestSha256'];
  if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(keys.sort()) || manifest.format !== 'waystone-assets-v1') throw new TypeError('waystone asset manifest format or fields are invalid');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > 10_000) throw new TypeError('waystone asset manifest file inventory is invalid');
  const paths = new Set<string>();
  const files = manifest.files.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('waystone asset entry is invalid');
    const entry = value as Record<string, unknown>;
    if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(['bytes', 'immutable', 'mediaType', 'path', 'sha256']) || entry.immutable !== true) throw new TypeError('waystone asset entry fields are invalid');
    if (typeof entry.path !== 'string' || !safeAssetPath(entry.path) || paths.has(entry.path)) throw new TypeError('waystone asset path is unsafe or duplicated');
    if (!Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0 || (entry.bytes as number) > 64 * 1024 * 1024) throw new TypeError('waystone asset size is invalid');
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.sha256)) throw new TypeError('waystone asset digest is invalid');
    if (typeof entry.mediaType !== 'string' || entry.mediaType.length === 0 || entry.mediaType.length > 256) throw new TypeError('waystone asset media type is invalid');
    paths.add(entry.path);
    return { path: entry.path, bytes: entry.bytes as number, sha256: entry.sha256 };
  });
  if (typeof manifest.entrypoint !== 'string' || !paths.has(manifest.entrypoint)) throw new TypeError('waystone entrypoint must name one immutable asset');
  if (typeof manifest.manifestSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(manifest.manifestSha256)) throw new TypeError('waystone manifest digest is invalid');
  const { manifestSha256, ...unsigned } = manifest;
  if (sha256(canonicalJson(unsigned)) !== manifestSha256) throw new TypeError('waystone manifest internal digest mismatch');
  return { files };
}

function safeAssetPath(path: string): boolean {
  const decoded = decodeURIComponent(path);
  return path === decoded
    && !path.startsWith('/')
    && !/^[A-Za-z]:/u.test(path)
    && !path.includes('\\')
    && !path.includes('?')
    && !path.includes('#')
    && path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function portableContainerSource(): PortableLegacySource {
  return {
    kind: 'read-only-portable-source-v1',
    databasePath: '/seedbed-legacy/source.sqlite',
    blobPath: '/seedbed-legacy/blobs',
    offlineAttestation: 'seedbed-filesystem-sidecars-absent-v1',
  };
}

function encodedResponseLimit(rawBytes: number): number {
  return Math.ceil((rawBytes * 4) / 3) + (1024 * 1024);
}

async function stageImmutableManifest(destination: string, bytes: Uint8Array, expectedDigest: string): Promise<void> {
  try {
    const existing = await lstat(destination);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new TypeError('staged waystone manifest must be a regular non-link file');
    if (sha256(await readFile(destination)) !== expectedDigest) throw new TypeError('staged waystone manifest conflicts with immutable coordinate');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(destination, bytes, { mode: 0o600, flag: 'wx' });
  }
}

async function assertProtectedDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new TypeError('Seedbed staging directory must be a regular non-link directory');
  const expected = resolve(path);
  const actual = await realpath(path);
  const equal = process.platform === 'win32'
    ? expected.toLowerCase() === actual.toLowerCase()
    : expected === actual;
  if (!equal) throw new TypeError('Seedbed staging directory must not traverse a symlink, junction, or path alias');
  if (process.platform !== 'win32') await chmod(path, 0o700);
}

export class OperatorAdoptionTarget extends ComposeRestoreTarget implements AdoptionTarget {
  constructor(config: SeedbedConfig, executor: SeedbedOperatorExecutor) {
    super(config, executor);
  }
  async importOwner(section: OwnerSection, stagingDirectory: string, operationId: string): Promise<void> {
    await this.executor.invoke(this.config, 'adoption-owner-import-v1', {
      section: {
        owner: section.owner,
        schemaVersion: section.schemaVersion,
        disposition: section.disposition,
        ledger: section.ledger,
        base64: Buffer.from(section.bytes).toString('base64'),
      },
      stagingDirectory,
      operationId,
    });
  }
  async stagePayload(id: string, source: AsyncIterable<Uint8Array>, stagingDirectory: string, operationId: string): Promise<void> {
    await this.executor.write(this.config, 'adoption-payload-stage-v1', { id, stagingDirectory, operationId }, source);
  }
  async collisionCheck(stagingDirectory: string, operationId: string) { await this.executor.invoke(this.config, 'adoption-payload-collision-check-v1', { stagingDirectory, operationId }); }
  async rebindPayloads(stagingDirectory: string, operationId: string) { await this.executor.invoke(this.config, 'adoption-payload-rebind-v1', { stagingDirectory, operationId }); }
  async commitPayloads(stagingDirectory: string, operationId: string) { await this.executor.invoke(this.config, 'adoption-payload-commit-v1', { stagingDirectory, operationId }); }
  async rollbackPayloads(stagingDirectory: string, operationId: string) { await this.executor.invoke(this.config, 'adoption-payload-rollback-v1', { stagingDirectory, operationId }); }
  async verify(stagingDirectory: string): Promise<AdoptionVerification> {
    return this.executor.invoke<AdoptionVerification>(this.config, 'adoption-diagnostics-v1', { stagingDirectory });
  }
}

async function version(args: string[]): Promise<{ available: boolean; version?: string }> {
  try {
    const result = await exec('docker', args, { encoding: 'utf8', windowsHide: true });
    return { available: true, version: result.stdout.trim().slice(0, 128) };
  } catch {
    return { available: false };
  }
}

function childCompletion(child: ReturnType<typeof spawn>, label: string): Promise<void> {
  const errors: Buffer[] = [];
  let bytes = 0;
  child.stderr?.on('data', (chunk: Buffer) => {
    if (bytes < 8192) {
      const bounded = chunk.subarray(0, 8192 - bytes);
      errors.push(bounded);
      bytes += bounded.byteLength;
    }
  });
  return new Promise<void>((resolveCompletion, rejectCompletion) => {
    child.once('error', rejectCompletion);
    child.once('close', (code) => {
      if (code === 0) resolveCompletion();
      else rejectCompletion(new Error(`${label} exited ${String(code)}: ${Buffer.concat(errors).toString('utf8').slice(0, 8192)}`));
    });
  });
}

function operatorContext(config: SeedbedConfig): unknown {
  return {
    format: 'gnolith-seedbed-operator-context-v1',
    installationId: config.installationId,
    baseIri: config.baseIri,
    databasePath: '/var/lib/gnolith/gnolith.sqlite',
    tokenFile: '/run/secrets/gnolith-bearer',
    credentialId: config.authentication.credentialId,
    packages: Object.fromEntries(['diamond', 'taproot', 'workshop'].map((owner) => {
      const key = owner as 'diamond' | 'taproot' | 'workshop';
      return [key, { version: config.packages[key].version, sha256: config.packages[key].sha256 }];
    })),
    migrations: config.migrations,
    backup: config.backup,
  };
}

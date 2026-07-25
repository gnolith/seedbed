import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { access, chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';
import { renderCompose, assertSafeComposeEnvironment } from './compose.js';
import type { SeedbedConfig } from './types.js';
import type { ComposeDriver } from './migration.js';
import type { DiagnosticHost, HostDiagnostics } from './diagnostics.js';
import type { AdoptionTarget, AdoptionVerification } from './adoption.js';
import type { OwnerSection } from './owner-ports.js';
import type { SeedbedOperatorExecutor } from './owner-ports.js';
import type { RestoreTarget } from './backup.js';
import { canonicalJson, redactFilesystemPaths, sha256 } from './canonical.js';
import type { LegacyAdapterExecutor, PortableLegacySource } from './legacy-source.js';
import { decodeCanonicalTextSecret, inspectProtectedCredential } from './secrets.js';

const exec = promisify(execFile);
const SEEDBED_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface SeedbedExecutionOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface OperatorProcess {
  readonly child: ReturnType<typeof spawn>;
  readonly containerName: string;
  readonly operation: string;
  readonly subject?: 'diamond' | 'taproot' | 'workshop';
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export class SeedbedOperatorTimeoutError extends Error {
  readonly code = 'seedbed-operator-timeout';
  readonly classification = 'seedbed-operation-timeout';
  readonly retryable = true;
  constructor(readonly operation: string) {
    super(`Seedbed operator ${operation} exceeded its bounded deadline and was terminated`);
    this.name = 'SeedbedOperatorTimeoutError';
  }
}

export class SeedbedOperationAbortedError extends Error {
  readonly code = 'seedbed-operation-aborted';
  readonly classification = 'seedbed-operation-aborted';
  readonly retryable = true;
  constructor(readonly operation: string) {
    super(`Seedbed operation ${operation} was aborted and its child process was terminated`);
    this.name = 'SeedbedOperationAbortedError';
  }
}

export class SeedbedOperatorExecutionError extends Error {
  readonly code = 'seedbed-operator-execution-failed';
  constructor(
    readonly operation: string,
    readonly stage: string,
    readonly classification: string,
    readonly diagnostic?: Readonly<Record<string, string | number | boolean>>,
    readonly retryable = false,
  ) {
    super(`Seedbed operator ${operation} failed at ${stage}: ${classification}`);
    this.name = 'SeedbedOperatorExecutionError';
  }
}

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

const IDEMPOTENT_OPERATOR_OPERATIONS = new Set([
  'owner-migration-plan-v1', 'owner-diagnostics-v1',
  'owner-backup-inspect-v1', 'owner-backup-export-v1', 'owner-backup-validate-v1',
  'taproot-blob-enumerate-v1', 'taproot-blob-open-v1', 'taproot-blob-collision-check-v1',
  'adoption-payload-collision-check-v1', 'adoption-diagnostics-v1',
  'restore-target-empty-v1',
  'legacy-owner-inspect-v1', 'legacy-owner-export-v1', 'legacy-taproot-payload-open-v1',
]);

export class DockerComposeDriver implements ComposeDriver, SeedbedOperatorExecutor, LegacyAdapterExecutor {
  constructor(
    private readonly artifactRoot = SEEDBED_PACKAGE_ROOT,
    private readonly execution: SeedbedExecutionOptions = {},
  ) {
    if (
      execution.timeoutMs !== undefined
      && (!Number.isSafeInteger(execution.timeoutMs) || execution.timeoutMs < 1 || execution.timeoutMs > 10 * 60_000)
    ) throw new TypeError('Seedbed execution timeout must be 1..600000 milliseconds');
  }

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
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
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
        await mkdir(dirname(assetDestination), { recursive: true, mode: 0o755 });
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
    const credentialVolume = runtimeCredentialVolume(config);
    await this.stageCredentialVolume(config, credentialVolume, 'runtime-v1');
    const args = this.args(config);
    for (const profile of config.compose.profiles) args.push('--profile', profile);
    args.push('up', '--build', '--detach', '--wait', '--force-recreate');
    try {
      await this.docker(args, 5 * 60_000);
    } catch (error) {
      const logs = await this.docker(
        [...this.args(config), 'logs', '--no-color', '--tail', '100', 'workshop'],
        10_000,
      ).then(
        (result) => `${result.stdout}\n${result.stderr}`,
        () => '',
      );
      await this.docker(['volume', 'rm', '--force', credentialVolume], 10_000).catch(() => undefined);
      const diagnostic = redactFilesystemPaths(logs)
        .replaceAll(/[A-Za-z0-9_-]{43}/gu, '[redacted-credential]')
        .trim()
        .slice(0, 4096);
      throw new Error(
        diagnostic ? `Workshop start failed: ${diagnostic}` : 'Workshop start failed without container diagnostics',
        { cause: error },
      );
    }
  }

  async ensureSemanticDependencies(config: SeedbedConfig): Promise<void> {
    const semantic = config.semantic?.configuration;
    if (semantic?.vector.kind !== 'qdrant') return;
    const credentialPath = semantic.vector.credentialSelector === null
      ? ''
      : `/run/secrets/gnolith-semantic-${sha256(semantic.vector.credentialSelector).slice(0, 16)}`;
    const script = [
      "const fs=require('node:fs');",
      "const [endpoint,collection,sizeText,distance,credentialPath]=process.argv.slice(1);",
      "const size=Number(sizeText);const headers={'content-type':'application/json'};",
      "if(credentialPath){const value=fs.readFileSync(credentialPath,'utf8').replace(/\\r?\\n$/u,'');if(!value||/^\\s|\\s$|[\\u0000-\\u001f\\u007f]/u.test(value))process.exit(1);headers['api-key']=value}",
      "const url=endpoint.replace(/\\/$/u,'')+'/collections/'+encodeURIComponent(collection);",
      "const check=async()=>{const response=await fetch(url,{headers,redirect:'error'});if(!response.ok)process.exit(1);const body=await response.json();const vectors=body?.result?.config?.params?.vectors;if(Number(vectors?.size)!==size||String(vectors?.distance??'').toLowerCase()!==distance.toLowerCase())process.exit(1)};",
      "(async()=>{const response=await fetch(url,{headers,redirect:'error'});if(response.status===404){const created=await fetch(url,{method:'PUT',headers,redirect:'error',body:JSON.stringify({vectors:{size,distance}})});if(!created.ok)throw new Error('create failed')}else if(!response.ok)throw new Error('lookup failed');await check()})().then(()=>process.exit(0),()=>process.exit(1));",
    ].join('');
    await this.docker([
      ...this.args(config),
      'exec',
      '-T',
      'workshop',
      'node',
      '-e',
      script,
      semantic.vector.endpoint,
      semantic.vector.collection,
      String(semantic.provider.dimensions),
      semantic.provider.metric === 'cosine'
        ? 'Cosine'
        : semantic.provider.metric === 'dot'
          ? 'Dot'
          : 'Euclid',
      credentialPath,
    ], 60_000);
  }

  async buildOperator(config: SeedbedConfig): Promise<void> {
    const args = this.args(config);
    for (const profile of config.compose.profiles) args.push('--profile', profile);
    args.push('build', 'workshop');
    await this.docker(args, 5 * 60_000);
  }

  async invoke<T>(config: SeedbedConfig, operation: string, input: unknown): Promise<T> {
    const protectedVolume = await this.stageProtectedOperatorVolume(config, operation);
    try {
      const attempts = IDEMPOTENT_OPERATOR_OPERATIONS.has(operation) ? 2 : 1;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const process = this.operatorProcess(
          config,
          operation,
          [],
          protectedVolume === undefined ? [] : protectedOperatorMountArgs(operation, protectedVolume),
          operatorSubject(input),
        );
        try {
          const { child } = process;
          const stdout = child.stdout!;
          const output: Buffer[] = [];
          let bytes = 0;
          const limit = operation === 'owner-backup-export-v1'
            ? encodedResponseLimit(config.backup.maxArchiveBytes)
            : 8 * 1024 * 1024;
          stdout.on('data', (chunk: Buffer) => {
            bytes += chunk.byteLength;
            if (bytes > limit) void terminateOperator(process);
            else output.push(chunk);
          });
          const completion = operatorCompletion(process, 'Seedbed Compose operator');
          const inputCompletion = writeOperatorInput(
            child.stdin!,
            singleInput(`${canonicalJson({ context: operatorContext(config), input })}\n`),
          );
          await settleOperatorIo(process, inputCompletion, completion);
          if (bytes > limit) throw new TypeError('Seedbed operator response exceeded configured bounds');
          return JSON.parse(Buffer.concat(output).toString('utf8')) as T;
        } catch (error) {
          await terminateOperator(process);
          if (
            attempt < attempts
            && error instanceof SeedbedOperatorExecutionError
            && error.classification === 'operator-input-closed'
          ) continue;
          throw error;
        }
      }
      throw new Error('Seedbed operator retry state is unreachable');
    } finally {
      if (protectedVolume !== undefined) {
        await this.docker(['volume', 'rm', '--force', protectedVolume], 10_000).catch(() => undefined);
      }
    }
  }

  async read(config: SeedbedConfig, operation: string, input: unknown): Promise<AsyncIterable<Uint8Array>> {
    const self = this;
    async function* stream(): AsyncIterable<Uint8Array> {
      const process = self.operatorProcess(config, operation, ['--stream-out']);
      const { child } = process;
      const stdin = child.stdin!;
      const stdout = child.stdout!;
      const completion = operatorCompletion(process, 'Seedbed Compose streaming operator');
      const inputCompletion = writeOperatorInput(
        stdin,
        singleInput(`${canonicalJson({ context: operatorContext(config), input })}\n`),
      );
      try {
        for await (const chunk of stdout) yield chunk as Buffer;
        await settleOperatorIo(process, inputCompletion, completion);
      } catch (error) {
        await terminateOperator(process);
        await completion.catch(() => undefined);
        throw error;
      }
    }
    return stream();
  }

  async write(config: SeedbedConfig, operation: string, input: unknown, source: AsyncIterable<Uint8Array>): Promise<void> {
    const metadata = Buffer.from(canonicalJson({ context: operatorContext(config), input })).toString('base64url');
    if (metadata.length > 8192) throw new TypeError('Seedbed streaming operator metadata is too large');
    const process = this.operatorProcess(config, operation, ['--stream-in', metadata]);
    const { child } = process;
    const stdin = child.stdin!;
    const completion = operatorCompletion(process, 'Seedbed Compose streaming operator');
    const inputCompletion = writeOperatorInput(stdin, source);
    try {
      await settleOperatorIo(process, inputCompletion, completion);
    } catch (error) {
      stdin.destroy();
      await terminateOperator(process);
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
    const process = this.operatorProcess(config, operation, [], this.legacyMounts(source));
    const { child } = process;
    const stdin = child.stdin!;
    const stdout = child.stdout!;
    const output: Buffer[] = [];
    let bytes = 0;
    const limit = encodedResponseLimit(config.backup.maxArchiveBytes);
    stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > limit) void terminateOperator(process);
      else output.push(chunk);
    });
    const completion = operatorCompletion(process, 'Seedbed legacy owner adapters');
    const inputCompletion = writeOperatorInput(
      stdin,
      singleInput(`${canonicalJson({ context: operatorContext(config), input, source: portableContainerSource() })}\n`),
    );
    await settleOperatorIo(process, inputCompletion, completion);
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
      const process = self.operatorProcess(config, operation, ['--stream-out'], self.legacyMounts(source));
      const { child } = process;
      const stdin = child.stdin!;
      const stdout = child.stdout!;
      const completion = operatorCompletion(process, 'Seedbed legacy Taproot payload adapter');
      const inputCompletion = writeOperatorInput(
        stdin,
        singleInput(`${canonicalJson({ context: operatorContext(config), input, source: portableContainerSource() })}\n`),
      );
      try {
        for await (const chunk of stdout) yield chunk as Buffer;
        await settleOperatorIo(process, inputCompletion, completion);
      } catch (error) {
        await terminateOperator(process);
        await completion.catch(() => undefined);
        throw error;
      }
    }
    return stream();
  }

  async health(config: SeedbedConfig): Promise<{ healthy: boolean }> {
    const result = await this.docker([...this.args(config), 'ps', '--format', 'json'], 5_000);
    const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
    const services = lines.map((line) => JSON.parse(line) as { Service?: string; Health?: string; State?: string });
    const workshop = services.find((entry) => entry.Service === 'workshop');
    return { healthy: workshop?.State === 'running' && (!workshop.Health || workshop.Health === 'healthy') };
  }

  async downRetainData(config: SeedbedConfig): Promise<void> {
    await this.docker([...this.args(config), 'down', '--remove-orphans'], 30_000);
    await this.docker(['volume', 'rm', '--force', runtimeCredentialVolume(config)], 10_000).catch(() => undefined);
  }

  private args(config: SeedbedConfig): string[] {
    const directory = join(config.paths.stateDirectory, 'compose');
    return ['compose', '--project-name', config.compose.projectName, '--file', join(directory, 'compose.yaml'), '--env-file', join(directory, 'compose.env')];
  }

  private operatorProcess(
    config: SeedbedConfig,
    operation: string,
    mode: readonly string[] = [],
    mounts: readonly string[] = [],
    subject?: 'diamond' | 'taproot' | 'workshop',
  ): OperatorProcess {
    if (!OPERATOR_OPERATIONS.has(operation)) throw new TypeError('Unsupported Seedbed operator operation');
    if (this.execution.signal?.aborted) throw new SeedbedOperationAbortedError(operation);
    const containerName = `gnolith-seedbed-op-${randomUUID().replaceAll('-', '')}`;
    const isolatedValidation = operation === 'owner-backup-validate-v1';
    const args = isolatedValidation
      ? [
          'run', '--rm', '--interactive', '--name', containerName,
          '--pull', 'never', '--network', 'none', '--read-only',
          '--user', '10001:10001', '--cap-drop', 'ALL',
          '--security-opt', 'no-new-privileges:true',
          '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
          '--entrypoint', 'node',
          `${config.compose.projectName}-workshop:local`,
          '/app/seedbed/operator-runner.mjs', operation, ...mode,
        ]
      : [
          ...this.args(config),
          ...config.compose.profiles.flatMap((profile) => ['--profile', profile]),
          '--profile', 'seedbed-operator',
          'run', '--rm', '--name', containerName, '--no-deps', '-T', ...mounts, 'seedbed-operator',
          operation, ...mode,
        ];
    const child = spawn('docker', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    return {
      child,
      containerName,
      operation,
      ...(subject === undefined ? {} : { subject }),
      timeoutMs: this.operationTimeout(operation),
      ...(this.execution.signal === undefined ? {} : { signal: this.execution.signal }),
    };
  }

  private operationTimeout(operation: string): number {
    const standard = operation === 'owner-diagnostics-v1'
      ? 30_000
      : operation === 'legacy-owner-inspect-v1'
        ? 8_000
        : operation.includes('inspect') || operation.includes('validate') || operation.includes('collision-check')
          ? 15_000
          : operation.includes('export') || operation.includes('import') || operation.includes('payload') || operation.includes('blob')
            ? 60_000
            : 30_000;
    return Math.min(standard, this.execution.timeoutMs ?? standard);
  }

  private async stageProtectedOperatorVolume(config: SeedbedConfig, operation: string): Promise<string | undefined> {
    if (operation !== 'workshop-bootstrap-v1' && operation !== 'workshop-semantic-configure-v1') return undefined;
    const volume = `gnolith-seedbed-secret-${randomUUID().replaceAll('-', '')}`;
    await this.stageCredentialVolume(config, volume, 'protected-operator-v1');
    return volume;
  }

  private async stageCredentialVolume(config: SeedbedConfig, volume: string, purpose: string): Promise<void> {
    await inspectProtectedCredential(config.authentication.tokenFile);
    const files: Record<string, string> = {
      'gnolith-bearer': Buffer.from(
        decodeCanonicalTextSecret(await readFile(config.authentication.tokenFile), 44),
        'utf8',
      ).toString('base64'),
    };
    for (const selector of config.semantic?.credentialSelectors ?? []) {
      const target = `gnolith-semantic-${sha256(selector.id).slice(0, 16)}`;
      files[target] = Buffer.from(
        decodeCanonicalTextSecret(await readFile(selector.path), 1024 * 1024),
        'utf8',
      ).toString('base64');
    }
    await this.docker(['volume', 'create', '--label', `dev.gnolith.seedbed=${purpose}`, volume], 10_000);
    const script = [
      "const fs=require('node:fs');",
      "let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;if(b.length>2097152)process.exit(2)});",
      "process.stdin.on('end',()=>{const v=JSON.parse(b);for(const n of fs.readdirSync('/seedbed-secrets')){if(!/^gnolith-(?:bearer|semantic-[0-9a-f]{16})$/.test(n))process.exit(3);fs.unlinkSync('/seedbed-secrets/'+n)}for(const [n,e] of Object.entries(v)){if(!/^gnolith-(?:bearer|semantic-[0-9a-f]{16})$/.test(n)||typeof e!=='string')process.exit(4);const p='/seedbed-secrets/'+n;fs.writeFileSync(p,Buffer.from(e,'base64'),{mode:0o400,flag:'wx'});fs.chownSync(p,10001,10001)}});",
    ].join('');
    const child = spawn('docker', [
      'run', '--rm', '--interactive', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges:true',
      '--user', '0:0', '--volume', `${volume}:/seedbed-secrets`,
      '--entrypoint', 'node', `${config.compose.projectName}-workshop:local`, '-e', script,
    ], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    const stderr: Buffer[] = [];
    child.stderr!.on('data', (chunk: Buffer) => {
      if (Buffer.concat(stderr).byteLength < 16 * 1024) stderr.push(chunk);
    });
    const inputCompletion = writeOperatorInput(
      child.stdin!,
      singleInput(`${canonicalJson(files)}\n`),
    );
    const completion = new Promise<void>((resolveStage, rejectStage) => {
      child.once('error', rejectStage);
      child.once('close', (code) => code === 0
        ? resolveStage()
        : rejectStage(new Error(`Protected operator credential staging failed: ${redactFilesystemPaths(Buffer.concat(stderr).toString('utf8')).slice(0, 512)}`)));
    });
    void completion.catch(() => undefined);
    try {
      const [inputResult, completionResult] = await Promise.allSettled([inputCompletion, completion]);
      if (inputResult.status === 'rejected') {
        throw new Error(`Protected operator credential staging input failed: ${operatorInputCode(inputResult.reason)}`);
      }
      if (completionResult.status === 'rejected') throw completionResult.reason;
    } catch (error) {
      await this.docker(['volume', 'rm', '--force', volume], 10_000).catch(() => undefined);
      throw error;
    }
  }

  private docker(args: readonly string[], standardTimeoutMs: number) {
    const timeout = Math.min(standardTimeoutMs, this.execution.timeoutMs ?? standardTimeoutMs);
    return exec('docker', [...args], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout,
      killSignal: 'SIGKILL',
      ...(this.execution.signal === undefined ? {} : { signal: this.execution.signal }),
    });
  }

  private legacyMounts(source: PortableLegacySource): string[] {
    return [
      '--volume', `${source.databasePath}:/seedbed-legacy/source.sqlite:ro`,
      '--volume', `${source.blobPath}:/seedbed-legacy/blobs:ro`,
    ];
  }
}

export function protectedOperatorMountArgs(operation: string, volume: string): readonly string[] {
  return operation === 'workshop-bootstrap-v1' || operation === 'workshop-semantic-configure-v1'
    ? ['--volume', `${volume}:/run/secrets:ro`]
    : [];
}

function runtimeCredentialVolume(config: SeedbedConfig): string {
  return `${config.compose.projectName}-protected-credentials`;
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
    await writeFile(destination, bytes, { mode: 0o444, flag: 'wx' });
  }
  if (process.platform !== 'win32') await chmod(destination, 0o444);
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
    const result = await exec('docker', args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3_000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    });
    return { available: true, version: result.stdout.trim().slice(0, 128) };
  } catch {
    return { available: false };
  }
}

async function* singleInput(value: string | Uint8Array): AsyncIterable<Uint8Array> {
  yield typeof value === 'string' ? Buffer.from(value) : value;
}

function writeOperatorInput(stdin: Writable, source: AsyncIterable<Uint8Array>): Promise<void> {
  const result = (async () => {
    let observedError: unknown;
    let rejectFailure!: (error: unknown) => void;
    const failure = new Promise<never>((_resolveFailure, reject) => {
      rejectFailure = reject;
    });
    void failure.catch(() => undefined);
    const fail = (error: unknown) => {
      if (observedError !== undefined) return;
      observedError = error;
      rejectFailure(error);
    };
    stdin.on('error', fail);
    stdin.on('close', () => {
      if (!stdin.writableFinished) {
        fail(Object.assign(new Error('Seedbed operator input closed before completion'), { code: 'EPIPE' }));
      }
    });
    try {
      for await (const chunk of source) {
        if (observedError !== undefined) throw observedError;
        const accepted = await new Promise<boolean>((resolveWrite) => {
          try {
            resolveWrite(stdin.write(chunk));
          } catch (error) {
            fail(error);
            resolveWrite(false);
          }
        });
        if (!accepted) {
          await Promise.race([
            new Promise<void>((resolveDrain) => stdin.once('drain', resolveDrain)),
            failure,
          ]);
        }
      }
      if (observedError !== undefined) throw observedError;
      stdin.end();
      await Promise.race([
        new Promise<void>((resolveFinish) => stdin.once('finish', resolveFinish)),
        failure,
      ]);
    } catch (error) {
      if (!stdin.destroyed) stdin.destroy();
      throw error;
    }
  })();
  void result.catch(() => undefined);
  return result;
}

async function settleOperatorIo(
  process: OperatorProcess,
  input: Promise<void>,
  completion: Promise<void>,
): Promise<void> {
  const [inputResult, completionResult] = await Promise.allSettled([input, completion]);
  if (inputResult.status === 'rejected') {
    const code = operatorInputCode(inputResult.reason);
    if (code === 'EPIPE' || code === 'EOF' || code === 'ERR_STREAM_DESTROYED') {
      const childClassification = completionResult.status === 'rejected'
        && completionResult.reason instanceof SeedbedOperatorExecutionError
        ? completionResult.reason.classification
        : undefined;
      const diagnostic: Record<string, string> = { causeCode: code };
      if (childClassification !== undefined) diagnostic.childClassification = childClassification;
      throw new SeedbedOperatorExecutionError(
        process.operation,
        classifyOperatorFailure(process.operation, process.subject, '').stage,
        'operator-input-closed',
        diagnostic,
        IDEMPOTENT_OPERATOR_OPERATIONS.has(process.operation),
      );
    }
    if (completionResult.status === 'rejected') throw completionResult.reason;
    throw new SeedbedOperatorExecutionError(
      process.operation,
      classifyOperatorFailure(process.operation, process.subject, '').stage,
      'operator-input-failed',
      { causeCode: code },
    );
  }
  if (completionResult.status === 'rejected') throw completionResult.reason;
}

function operatorInputCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return 'UNKNOWN';
  const code = String((error as { code?: unknown }).code);
  return /^[A-Z][A-Z0-9_]{1,31}$/u.test(code) ? code : 'UNKNOWN';
}

function operatorCompletion(process: OperatorProcess, label: string): Promise<void> {
  const { child } = process;
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderrBytes >= 8192) return;
    const bounded = chunk.subarray(0, 8192 - stderrBytes);
    stderr.push(bounded);
    stderrBytes += bounded.byteLength;
  });
  const completion = new Promise<void>((resolveCompletion, rejectCompletion) => {
    let termination: 'timeout' | 'aborted' | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.signal?.removeEventListener('abort', abort);
      if (error === undefined) resolveCompletion();
      else rejectCompletion(error);
    };
    const timeout = () => {
      termination = 'timeout';
      void terminateOperator(process);
    };
    const abort = () => {
      termination = process.signal?.reason instanceof DOMException && process.signal.reason.name === 'TimeoutError'
        ? 'timeout'
        : 'aborted';
      void terminateOperator(process);
    };
    const timer = setTimeout(timeout, process.timeoutMs);
    timer.unref();
    process.signal?.addEventListener('abort', abort, { once: true });
    if (process.signal?.aborted) abort();
    child.once('error', (error) => finish(new Error(`${label} could not start: ${redactFilesystemPaths(error.message).slice(0, 1024)}`)));
    child.once('close', (code) => {
      if (termination === 'timeout') finish(new SeedbedOperatorTimeoutError(process.operation));
      else if (termination === 'aborted') finish(new SeedbedOperationAbortedError(process.operation));
      else if (code === 0) finish();
      else {
        const diagnostic = classifyOperatorFailure(
          process.operation,
          process.subject,
          redactFilesystemPaths(Buffer.concat(stderr).toString('utf8')),
        );
        finish(new SeedbedOperatorExecutionError(
          process.operation,
          diagnostic.stage,
          diagnostic.classification,
          safeOperatorDiagnostic(Buffer.concat(stderr).toString('utf8')),
        ));
      }
    });
  });
  void completion.catch(() => undefined);
  return completion;
}

function safeOperatorDiagnostic(stderr: string): Readonly<Record<string, string | number | boolean>> | undefined {
  const line = stderr.trim().split(/\r?\n/u).at(-1);
  if (!line || line.length > 8192) return undefined;
  try {
    const parsed = JSON.parse(line) as { diagnostic?: unknown };
    if (!parsed.diagnostic || typeof parsed.diagnostic !== 'object' || Array.isArray(parsed.diagnostic)) return undefined;
    const allowed = new Set([
      'format', 'owner', 'documentFormat', 'documentVersion', 'schemaVersion',
      'installationMatches', 'ownedStateFormat', 'ownedStateInstallationMatches',
      'tableCount', 'rowCount', 'credentialCount', 'distinctCredentialDigestCount',
      'documentSha256', 'causeName', 'causeCode', 'causeReason',
      'causeBackupReason', 'causeTable', 'causeLogicalKeyCount',
      'ledgerNamespace', 'payloadKind', 'payloadBytes', 'quadCount', 'guardCount',
      'declaredPayloadSha256', 'actualPayloadSha256', 'payloadSha256Matches',
      'targetInstallationSha256',
    ]);
    const output: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(parsed.diagnostic)) {
      if (!allowed.has(key)) return undefined;
      if (typeof value === 'string') {
        if (value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
        output[key] = value;
      } else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= -1 && value <= 1_000_000) {
        output[key] = value;
      } else if (typeof value === 'boolean') {
        output[key] = value;
      } else {
        return undefined;
      }
    }
    return output.format === 'gnolith-seedbed-owner-validation-diagnostic-v1' ? Object.freeze(output) : undefined;
  } catch {
    return undefined;
  }
}

export function classifyOperatorFailure(operation: string, subject: OperatorProcess['subject'], stderr: string): { stage: string; classification: string } {
  const stage = operation.startsWith('owner-backup-')
    ? `owner-backup-${subject === undefined ? '' : `${subject}-`}${operation.slice('owner-backup-'.length).replace(/-v1$/u, '')}`
    : operation.startsWith('legacy-')
      ? `legacy-${operation.slice('legacy-'.length).replace(/-v1$/u, '')}`
      : operation.replace(/-v1$/u, '');
  const classification = /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/iu.test(stderr)
    ? 'operator-dependency-unavailable'
    : /ENOENT|no such file|not found/iu.test(stderr)
      ? 'required-input-unavailable'
      : /EACCES|EPERM|permission denied/iu.test(stderr)
        ? 'required-input-access-denied'
        : /integrity|checksum|digest mismatch/iu.test(stderr)
          ? 'integrity-verification-failed'
          : /UNIQUE constraint|constraint failed|conflict/iu.test(stderr)
            ? 'owner-state-conflict'
            : /backup validation failed|backup.*invalid/iu.test(stderr)
              ? 'owner-backup-invalid'
              : operation.startsWith('legacy-')
                ? 'legacy-adapter-rejected'
                : operation.startsWith('owner-backup-')
                  ? 'owner-backup-rejected'
                  : 'operator-operation-rejected';
  return { stage, classification };
}

function operatorSubject(input: unknown): OperatorProcess['subject'] {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const direct = record.owner;
  const section = record.section && typeof record.section === 'object'
    ? (record.section as Record<string, unknown>).owner
    : undefined;
  const subject = direct ?? section;
  return subject === 'diamond' || subject === 'taproot' || subject === 'workshop' ? subject : undefined;
}

async function terminateOperator(process: OperatorProcess): Promise<void> {
  const work: Promise<unknown>[] = [
    exec('docker', ['rm', '--force', process.containerName], {
      windowsHide: true,
      timeout: 5_000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    }).catch(() => undefined),
  ];
  if (process.child.pid !== undefined && process.child.exitCode === null) {
    process.child.kill('SIGKILL');
    if (globalThis.process.platform === 'win32') {
      work.push(exec('taskkill', ['/pid', String(process.child.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5_000,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
      }).catch(() => undefined));
    }
  }
  await Promise.allSettled(work);
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

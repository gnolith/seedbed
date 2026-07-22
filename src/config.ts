import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { SeedbedError, ExitCode } from './errors.js';
import { canonicalizeTaprootBaseIri } from '@gnolith/taproot';

export interface SeedbedConfig {
  databasePath: string;
  blobPath?: string;
  busyTimeoutMs?: number;
  baseIri?: string;
  rootSecretFile?: string;
  rootSecretFd?: number;
  principalSelector?: string;
  workspaceSelector?: string;
  logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  shutdownTimeoutMs: number;
  semanticConfigurations?: readonly SemanticConfiguration[];
}

export interface SecretSelector { file?: string; fd?: number }
export interface SemanticConfiguration {
  id: string;
  name: string;
  selected?: boolean;
  provider: {
    kind: 'openai-compatible' | 'ollama-compatible';
    endpoint: string;
    model: string;
    dimensions: number;
    metric?: 'cosine' | 'dot' | 'euclid';
    allowPrivateEndpoint?: boolean;
    secret?: SecretSelector;
  };
  vectorIndex: {
    kind: 'sqlite' | 'qdrant';
    endpoint?: string;
    collection?: string;
    allowPrivateEndpoint?: boolean;
    secret?: SecretSelector;
  };
}

export interface ConfigOverrides {
  databasePath?: string;
  blobPath?: string;
  busyTimeoutMs?: number | string;
  baseIri?: string;
  rootSecretFile?: string;
  rootSecretFd?: number | string;
  principalSelector?: string;
  workspaceSelector?: string;
  logLevel?: string;
  shutdownTimeoutMs?: number | string;
  configPath?: string;
  semanticConfigurations?: readonly SemanticConfiguration[];
}

const logLevels = new Set<SeedbedConfig['logLevel']>([
  'silent',
  'error',
  'warn',
  'info',
  'debug',
]);

export async function loadConfig(
  cli: ConfigOverrides = {},
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<SeedbedConfig> {
  const configPath = resolve(cwd, cli.configPath ?? 'seedbed.config.json');
  let file: ConfigOverrides = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('root must be an object');
    }
    file = parsed as ConfigOverrides;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new SeedbedError(
        `Invalid configuration file ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
        ExitCode.configuration,
        'invalid_config',
        { cause: error },
      );
    }
  }

  const databaseValue = first(
    cli.databasePath,
    environment.SEEDBED_DATABASE_PATH,
    file.databasePath,
    './.seedbed/gnolith.sqlite',
  )!;
  const databasePath = isAbsolute(databaseValue)
    ? databaseValue
    : resolve(cwd, databaseValue);
  const blobValue = first(
    cli.blobPath,
    environment.SEEDBED_BLOB_PATH,
    file.blobPath,
    './.seedbed/blobs',
  )!;
  const blobPath = isAbsolute(blobValue) ? blobValue : resolve(cwd, blobValue);
  const busyTimeoutRaw = first(
    cli.busyTimeoutMs,
    environment.SEEDBED_BUSY_TIMEOUT_MS,
    file.busyTimeoutMs,
    5_000,
  );
  const busyTimeoutMs = Number(busyTimeoutRaw);
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 300_000) {
    throw new SeedbedError(
      'busyTimeoutMs must be an integer from 0 through 300000',
      ExitCode.configuration,
      'invalid_config',
    );
  }
  const baseIriValue = optional(first(cli.baseIri, environment.SEEDBED_BASE_IRI, file.baseIri));
  const baseIri = baseIriValue === undefined ? undefined : validateBaseIri(baseIriValue);

  const rootSecretFileValue = optional(first(cli.rootSecretFile, environment.SEEDBED_ROOT_SECRET_FILE, file.rootSecretFile));
  const rootSecretFile = rootSecretFileValue === undefined ? undefined : (isAbsolute(rootSecretFileValue) ? rootSecretFileValue : resolve(cwd, rootSecretFileValue));
  const rootSecretFdRaw = first(cli.rootSecretFd, environment.SEEDBED_ROOT_SECRET_FD, file.rootSecretFd);
  const rootSecretFd = rootSecretFdRaw === undefined ? undefined : Number(rootSecretFdRaw);
  if (rootSecretFd !== undefined && (!Number.isSafeInteger(rootSecretFd) || rootSecretFd < 3)) {
    throw new SeedbedError('rootSecretFd must be an inherited descriptor number of at least 3', ExitCode.configuration, 'invalid_root_secret');
  }
  if (rootSecretFile !== undefined && rootSecretFd !== undefined) {
    throw new SeedbedError('Configure only one root-secret selector', ExitCode.configuration, 'invalid_root_secret');
  }
  const principalSelector = optional(first(cli.principalSelector, environment.SEEDBED_PRINCIPAL_SELECTOR, file.principalSelector));
  const workspaceSelector = optional(first(cli.workspaceSelector, environment.SEEDBED_WORKSPACE_SELECTOR, file.workspaceSelector));
  const semanticConfigurations = normalizeSemanticConfigurations(file.semanticConfigurations, cwd);

  const logLevelValue = first(
    cli.logLevel,
    environment.SEEDBED_LOG_LEVEL,
    file.logLevel,
    'info',
  )!;
  if (!logLevels.has(logLevelValue as SeedbedConfig['logLevel'])) {
    throw new SeedbedError(
      `Invalid log level ${logLevelValue}`,
      ExitCode.configuration,
      'invalid_config',
    );
  }

  const shutdownRaw = first(
    cli.shutdownTimeoutMs,
    environment.SEEDBED_SHUTDOWN_TIMEOUT_MS,
    file.shutdownTimeoutMs,
    10_000,
  );
  const shutdownTimeoutMs = Number(shutdownRaw);
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 100 || shutdownTimeoutMs > 300_000) {
    throw new SeedbedError(
      'shutdownTimeoutMs must be an integer from 100 through 300000',
      ExitCode.configuration,
      'invalid_config',
    );
  }

  return {
    databasePath,
    blobPath,
    busyTimeoutMs,
    ...(baseIri === undefined ? {} : { baseIri }),
    ...(rootSecretFile === undefined ? {} : { rootSecretFile }),
    ...(rootSecretFd === undefined ? {} : { rootSecretFd }),
    ...(principalSelector === undefined ? {} : { principalSelector }),
    ...(workspaceSelector === undefined ? {} : { workspaceSelector }),
    logLevel: logLevelValue as SeedbedConfig['logLevel'],
    shutdownTimeoutMs,
    ...(semanticConfigurations.length === 0 ? {} : { semanticConfigurations }),
  };
}

function normalizeSemanticConfigurations(value: readonly SemanticConfiguration[] | undefined, cwd: string): readonly SemanticConfiguration[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new SeedbedError('semanticConfigurations must be an array', ExitCode.configuration, 'invalid_config');
  const ids = new Set<string>();
  let selected = 0;
  return Object.freeze(value.map((entry) => {
    if (!entry || typeof entry !== 'object' || !entry.id?.trim() || !entry.name?.trim()) throw new SeedbedError('Each semantic configuration requires id and name', ExitCode.configuration, 'invalid_config');
    if (ids.has(entry.id)) throw new SeedbedError(`Duplicate semantic configuration ${entry.id}`, ExitCode.configuration, 'invalid_config');
    ids.add(entry.id);
    if (entry.selected && ++selected > 1) throw new SeedbedError('Only one semantic configuration may be selected', ExitCode.configuration, 'invalid_config');
    if (!['openai-compatible', 'ollama-compatible'].includes(entry.provider?.kind) || !entry.provider.endpoint || !entry.provider.model || !Number.isSafeInteger(entry.provider.dimensions) || entry.provider.dimensions < 1) {
      throw new SeedbedError(`Invalid provider for semantic configuration ${entry.id}`, ExitCode.configuration, 'invalid_config');
    }
    if (!['sqlite', 'qdrant'].includes(entry.vectorIndex?.kind) || (entry.vectorIndex.kind === 'qdrant' && (!entry.vectorIndex.endpoint || !entry.vectorIndex.collection))) {
      throw new SeedbedError(`Invalid vector index for semantic configuration ${entry.id}`, ExitCode.configuration, 'invalid_config');
    }
    return Object.freeze({
      ...entry,
      provider: Object.freeze({ ...entry.provider, ...(entry.provider.secret ? { secret: normalizeSecretSelector(entry.provider.secret, cwd, 'provider') } : {}) }),
      vectorIndex: Object.freeze({ ...entry.vectorIndex, ...(entry.vectorIndex.secret ? { secret: normalizeSecretSelector(entry.vectorIndex.secret, cwd, 'vector index') } : {}) }),
    });
  }));
}

function normalizeSecretSelector(selector: SecretSelector, cwd: string, label: string): SecretSelector {
  if ((selector.file === undefined) === (selector.fd === undefined)) throw new SeedbedError(`${label} secret must select exactly one file or inherited descriptor`, ExitCode.configuration, 'invalid_config');
  if (selector.fd !== undefined && (!Number.isSafeInteger(selector.fd) || selector.fd < 3)) throw new SeedbedError(`${label} secret descriptor must be at least 3`, ExitCode.configuration, 'invalid_config');
  return selector.file === undefined ? { fd: selector.fd! } : { file: isAbsolute(selector.file) ? selector.file : resolve(cwd, selector.file) };
}

export function requireBaseIri(config: SeedbedConfig): string {
  if (!config.baseIri) {
    throw new SeedbedError(
      'A stable absolute HTTP(S) base IRI is required; use --base-iri or SEEDBED_BASE_IRI',
      ExitCode.configuration,
      'base_iri_required',
    );
  }
  return validateBaseIri(config.baseIri);
}

function validateBaseIri(value: string): string {
  try {
    return canonicalizeTaprootBaseIri(value);
  } catch (error) {
    throw new SeedbedError(
      `Invalid base IRI ${value}: ${error instanceof Error ? error.message : String(error)}`,
      ExitCode.configuration,
      'invalid_base_iri',
      { cause: error },
    );
  }
}

function first<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value): value is T => value !== undefined);
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

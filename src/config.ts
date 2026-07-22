import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { SeedbedError, ExitCode } from './errors.js';
import { canonicalizeTaprootBaseIri } from '@gnolith/taproot';

export interface SeedbedConfig {
  databasePath: string;
  baseIri?: string;
  rootSecretFile?: string;
  rootSecretFd?: number;
  principalSelector?: string;
  workspaceSelector?: string;
  logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  shutdownTimeoutMs: number;
}

export interface ConfigOverrides {
  databasePath?: string;
  baseIri?: string;
  rootSecretFile?: string;
  rootSecretFd?: number | string;
  principalSelector?: string;
  workspaceSelector?: string;
  logLevel?: string;
  shutdownTimeoutMs?: number | string;
  configPath?: string;
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
    ...(baseIri === undefined ? {} : { baseIri }),
    ...(rootSecretFile === undefined ? {} : { rootSecretFile }),
    ...(rootSecretFd === undefined ? {} : { rootSecretFd }),
    ...(principalSelector === undefined ? {} : { principalSelector }),
    ...(workspaceSelector === undefined ? {} : { workspaceSelector }),
    logLevel: logLevelValue as SeedbedConfig['logLevel'],
    shutdownTimeoutMs,
  };
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

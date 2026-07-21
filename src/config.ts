import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { SeedbedError, ExitCode } from './errors.js';

export interface SeedbedConfig {
  databasePath: string;
  baseIri?: string;
  localOwnerId: string;
  logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  shutdownTimeoutMs: number;
}

export interface ConfigOverrides {
  databasePath?: string;
  baseIri?: string;
  localOwnerId?: string;
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
  );
  const databasePath = isAbsolute(databaseValue)
    ? databaseValue
    : resolve(cwd, databaseValue);
  const baseIri = optional(first(cli.baseIri, environment.SEEDBED_BASE_IRI, file.baseIri));
  if (baseIri !== undefined) validateBaseIri(baseIri);

  const localOwnerId = first(
    cli.localOwnerId,
    environment.SEEDBED_LOCAL_OWNER_ID,
    file.localOwnerId,
    'local-owner',
  ).trim();
  if (!localOwnerId || localOwnerId.length > 256) {
    throw new SeedbedError(
      'localOwnerId must be a non-empty string of at most 256 characters',
      ExitCode.configuration,
      'invalid_principal',
    );
  }

  const logLevelValue = first(
    cli.logLevel,
    environment.SEEDBED_LOG_LEVEL,
    file.logLevel,
    'info',
  );
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
    localOwnerId,
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
  validateBaseIri(config.baseIri);
  return config.baseIri;
}

function validateBaseIri(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new SeedbedError(
      `Invalid base IRI: ${value}`,
      ExitCode.configuration,
      'invalid_base_iri',
      { cause: error },
    );
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password || url.hash) {
    throw new SeedbedError(
      'baseIri must be an absolute HTTP(S) URL without credentials or a fragment',
      ExitCode.configuration,
      'invalid_base_iri',
    );
  }
}

function first<T>(...values: Array<T | undefined>): T {
  return values.find((value): value is T => value !== undefined) as T;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}


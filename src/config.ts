import { readFile } from 'node:fs/promises';
import { isAbsolute, normalize, relative, resolve } from 'node:path';
import { assertLowerSha256, canonicalJson, digestObject } from './canonical.js';
import type { ImmutableCoordinate, SecretSelector, SeedbedConfig } from './types.js';

const TOP_KEYS = ['formatVersion', 'installationId', 'baseIri', 'packages', 'compose', 'paths', 'authentication', 'endpoints', 'migrations', 'backup'] as const;
const PROJECT_RE = /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/u;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export async function loadConfig(path: string, cwd = process.cwd()): Promise<SeedbedConfig> {
  const absolute = resolve(cwd, path);
  const parsed: unknown = JSON.parse(await readFile(absolute, 'utf8'));
  return validateConfig(parsed, { projectDirectory: cwd });
}

export function validateConfig(value: unknown, options: { projectDirectory: string }): SeedbedConfig {
  const root = object(value, 'config');
  exactKeys(root, TOP_KEYS, 'config');
  if (root.formatVersion !== 1) fail('formatVersion must be 1');
  const installationId = identifier(root.installationId, 'installationId');
  const baseIri = canonicalBaseIri(root.baseIri);
  const packagesValue = object(root.packages, 'packages');
  exactKeys(packagesValue, ['diamond', 'taproot', 'workshop', 'waystone'], 'packages', ['waystone']);
  const packages = {
    diamond: coordinate(packagesValue.diamond, 'packages.diamond'),
    taproot: coordinate(packagesValue.taproot, 'packages.taproot'),
    workshop: coordinate(packagesValue.workshop, 'packages.workshop'),
    ...(packagesValue.waystone === undefined ? {} : { waystone: coordinate(packagesValue.waystone, 'packages.waystone') }),
  };

  const composeValue = object(root.compose, 'compose');
  exactKeys(composeValue, ['projectName', 'workshopPort', 'publishIpv6Loopback', 'profiles', 'networkName', 'dataVolume', 'qdrantVolume', 'nodeImage', 'qdrantImage', 'ollamaImage'], 'compose', ['qdrantVolume', 'qdrantImage', 'ollamaImage']);
  const projectName = text(composeValue.projectName, 'compose.projectName');
  if (!PROJECT_RE.test(projectName)) fail('compose.projectName contains unsafe characters');
  const workshopPort = integer(composeValue.workshopPort, 'compose.workshopPort', 1, 65535);
  if (typeof composeValue.publishIpv6Loopback !== 'boolean') fail('compose.publishIpv6Loopback must be boolean');
  const profiles = stringArray(composeValue.profiles, 'compose.profiles');
  if (new Set(profiles).size !== profiles.length || profiles.some((profile) => !['qdrant', 'ollama', 'waystone'].includes(profile))) {
    fail('compose.profiles must contain unique qdrant, ollama, or waystone values');
  }
  if (profiles.includes('qdrant') && (composeValue.qdrantVolume === undefined || composeValue.qdrantImage === undefined)) fail('qdrant profile requires qdrantVolume and qdrantImage');
  if (profiles.includes('ollama') && composeValue.ollamaImage === undefined) fail('ollama profile requires ollamaImage');
  if (profiles.includes('waystone') && packages.waystone === undefined) fail('waystone profile requires an immutable package coordinate');
  for (const key of ['networkName', 'dataVolume', 'qdrantVolume'] as const) {
    if (composeValue[key] !== undefined && !PROJECT_RE.test(text(composeValue[key], `compose.${key}`))) fail(`compose.${key} contains unsafe characters`);
  }
  for (const key of ['nodeImage', 'qdrantImage', 'ollamaImage'] as const) {
    if (composeValue[key] !== undefined && !isDigestPinnedImage(text(composeValue[key], `compose.${key}`))) fail(`compose.${key} must be pinned by sha256 digest`);
  }

  const pathsValue = object(root.paths, 'paths');
  exactKeys(pathsValue, ['stateDirectory', 'dataDirectory', 'backupDirectory'], 'paths');
  const paths = {
    stateDirectory: safeAbsolutePath(pathsValue.stateDirectory, 'paths.stateDirectory'),
    dataDirectory: safeAbsolutePath(pathsValue.dataDirectory, 'paths.dataDirectory'),
    backupDirectory: safeAbsolutePath(pathsValue.backupDirectory, 'paths.backupDirectory'),
  };
  const project = normalize(resolve(options.projectDirectory));
  for (const [name, path] of Object.entries(paths)) {
    if (isWithin(path, project)) fail(`paths.${name} must be outside the project/worktree`);
  }

  const authValue = object(root.authentication, 'authentication');
  exactKeys(authValue, ['mode', 'credentialId', 'tokenFile'], 'authentication');
  if (authValue.mode !== 'local-bearer-v1') fail('authentication.mode must be local-bearer-v1');
  const tokenFile = safeAbsolutePath(authValue.tokenFile, 'authentication.tokenFile');
  if (!isWithin(tokenFile, paths.stateDirectory)) fail('authentication.tokenFile must be inside paths.stateDirectory');

  const endpointsValue = object(root.endpoints, 'endpoints');
  exactKeys(endpointsValue, ['ollama', 'qdrant', 'providerCredential', 'vectorCredential'], 'endpoints', ['ollama', 'qdrant', 'providerCredential', 'vectorCredential']);
  const endpoints = {
    ...(endpointsValue.ollama === undefined ? {} : { ollama: endpoint(endpointsValue.ollama, 'endpoints.ollama') }),
    ...(endpointsValue.qdrant === undefined ? {} : { qdrant: endpoint(endpointsValue.qdrant, 'endpoints.qdrant') }),
    ...(endpointsValue.providerCredential === undefined ? {} : { providerCredential: selector(endpointsValue.providerCredential, 'endpoints.providerCredential') }),
    ...(endpointsValue.vectorCredential === undefined ? {} : { vectorCredential: selector(endpointsValue.vectorCredential, 'endpoints.vectorCredential') }),
  };

  const migrationsValue = object(root.migrations, 'migrations');
  exactKeys(migrationsValue, ['diamond', 'taproot', 'workshop', 'expectedCatalogDigest'], 'migrations');
  assertLowerSha256(migrationsValue.expectedCatalogDigest, 'migrations.expectedCatalogDigest');

  const backupValue = object(root.backup, 'backup');
  exactKeys(backupValue, ['maxArchiveBytes', 'maxBlobBytes', 'retain'], 'backup');

  const config: SeedbedConfig = {
    formatVersion: 1,
    installationId,
    baseIri,
    packages,
    compose: {
      projectName,
      workshopPort,
      publishIpv6Loopback: composeValue.publishIpv6Loopback,
      profiles: profiles as SeedbedConfig['compose']['profiles'],
      networkName: text(composeValue.networkName, 'compose.networkName'),
      dataVolume: text(composeValue.dataVolume, 'compose.dataVolume'),
      ...(composeValue.qdrantVolume === undefined ? {} : { qdrantVolume: text(composeValue.qdrantVolume, 'compose.qdrantVolume') }),
      nodeImage: text(composeValue.nodeImage, 'compose.nodeImage'),
      ...(composeValue.qdrantImage === undefined ? {} : { qdrantImage: text(composeValue.qdrantImage, 'compose.qdrantImage') }),
      ...(composeValue.ollamaImage === undefined ? {} : { ollamaImage: text(composeValue.ollamaImage, 'compose.ollamaImage') }),
    },
    paths,
    authentication: {
      mode: 'local-bearer-v1',
      credentialId: identifier(authValue.credentialId, 'authentication.credentialId'),
      tokenFile,
    },
    endpoints,
    migrations: {
      diamond: text(migrationsValue.diamond, 'migrations.diamond'),
      taproot: text(migrationsValue.taproot, 'migrations.taproot'),
      workshop: text(migrationsValue.workshop, 'migrations.workshop'),
      expectedCatalogDigest: migrationsValue.expectedCatalogDigest,
    },
    backup: {
      maxArchiveBytes: integer(backupValue.maxArchiveBytes, 'backup.maxArchiveBytes', 1, 1_073_741_824),
      maxBlobBytes: integer(backupValue.maxBlobBytes, 'backup.maxBlobBytes', 1, 536_870_912),
      retain: integer(backupValue.retain, 'backup.retain', 1, 1000),
    },
  };
  return Object.freeze(config);
}

export function configDigest(config: SeedbedConfig): string {
  return digestObject(config);
}

export function redactConfig(config: SeedbedConfig): unknown {
  return JSON.parse(canonicalJson(config));
}

function coordinate(value: unknown, label: string): ImmutableCoordinate {
  const record = object(value, label);
  exactKeys(record, ['version', 'artifact', 'sha256', 'sourceCommit'], label);
  const artifact = safeRelativeArtifact(record.artifact, `${label}.artifact`);
  assertLowerSha256(record.sha256, `${label}.sha256`);
  if (typeof record.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(record.sourceCommit)) fail(`${label}.sourceCommit must be lowercase 40-character Git commit`);
  return { version: semver(record.version, `${label}.version`), artifact, sha256: record.sha256, sourceCommit: record.sourceCommit };
}

function selector(value: unknown, label: string): SecretSelector {
  const record = object(value, label);
  exactKeys(record, ['kind', 'value'], label);
  if (!['protected-file', 'inherited-fd', 'environment'].includes(String(record.kind))) fail(`${label}.kind is invalid`);
  const selected = text(record.value, `${label}.value`);
  if (record.kind === 'environment' && !/^[A-Z][A-Z0-9_]{0,127}$/u.test(selected)) fail(`${label}.value is not an environment selector`);
  if (record.kind === 'inherited-fd' && !/^[3-9][0-9]*$/u.test(selected)) fail(`${label}.value is not an inherited descriptor`);
  const normalized = record.kind === 'protected-file' ? safeAbsolutePath(selected, `${label}.value`) : selected;
  return { kind: record.kind as SecretSelector['kind'], value: normalized };
}

function endpoint(value: unknown, label: string): string {
  const result = text(value, label);
  const url = new URL(result);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail(`${label} must be credential-free HTTP(S) without query credentials`);
  return url.toString();
}

function canonicalBaseIri(value: unknown): string {
  const url = new URL(text(value, 'baseIri'));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('baseIri must be absolute credential-free HTTP(S)');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

function safeAbsolutePath(value: unknown, label: string): string {
  const result = text(value, label);
  if (!isAbsolute(result) || /[\0\r\n]/u.test(result)) fail(`${label} must be an absolute local path without control characters`);
  if (/^\\\\/u.test(result) || /^\/\/[^/]/u.test(result)) fail(`${label} must not be a network path`);
  return normalize(result);
}

function safeRelativeArtifact(value: unknown, label: string): string {
  const result = text(value, label).replaceAll('\\', '/');
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(result)
    || result.startsWith('/')
    || result.split('/').some((part) => !part || part === '.' || part === '..')
  ) fail(`${label} must be a normalized Docker-build-safe relative artifact path`);
  return result;
}

function isDigestPinnedImage(value: string): boolean {
  return /^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$/u.test(value);
}

function isWithin(path: string, parent: string): boolean {
  const relation = relative(resolve(parent), resolve(path));
  return relation === '' || (!/^\.\.(?:[\\/]|$)/u.test(relation) && !isAbsolute(relation));
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string, optional: readonly string[] = []): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length) fail(`${label} has unknown keys: ${unknown.slice(0, 10).sort().join(', ')}`);
  const missing = allowed.filter((key) => !optional.includes(key) && !(key in record));
  if (missing.length) fail(`${label} is missing keys: ${missing.join(', ')}`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.length > 2048) fail(`${label} must be bounded nonblank text`);
  return value;
}

function identifier(value: unknown, label: string): string {
  const result = text(value, label);
  if (!ID_RE.test(result)) fail(`${label} is invalid`);
  return result;
}

function semver(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(result)) fail(`${label} must be exact semver`);
  return result;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(`${label} must be an integer from ${min} through ${max}`);
  return value as number;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 10 || value.some((entry) => typeof entry !== 'string')) fail(`${label} must be a bounded string array`);
  return [...value] as string[];
}

function fail(message: string): never {
  throw new TypeError(message);
}

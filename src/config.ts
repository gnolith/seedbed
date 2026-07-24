import { readFile } from 'node:fs/promises';
import { isAbsolute, normalize, relative, resolve } from 'node:path';
import { assertLowerSha256, canonicalJson, digestObject } from './canonical.js';
import type { ImmutableCoordinate, SecretSelector, SeedbedConfig, SemanticConfigurationV1 } from './types.js';

const TOP_KEYS = ['formatVersion', 'installationId', 'baseIri', 'packages', 'compose', 'paths', 'authentication', 'endpoints', 'semantic', 'migrations', 'backup'] as const;
const PROJECT_RE = /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/u;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export async function loadConfig(path: string, cwd = process.cwd()): Promise<SeedbedConfig> {
  const absolute = resolve(cwd, path);
  const parsed: unknown = JSON.parse(await readFile(absolute, 'utf8'));
  return validateConfig(parsed, { projectDirectory: cwd });
}

export function validateConfig(value: unknown, options: { projectDirectory: string }): SeedbedConfig {
  const root = object(value, 'config');
  exactKeys(root, TOP_KEYS, 'config', ['semantic']);
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

  const semantic = root.semantic === undefined ? undefined : semanticConfiguration(root.semantic);
  if (semantic !== undefined) {
    if (semantic.credentialSelectors.some(({ path }) => isWithin(path, project))) {
      fail('semantic protected credential files must be outside the project/worktree');
    }
    const expectsOllama = semantic.configuration.provider.kind === 'ollama-compatible';
    const expectsQdrant = semantic.configuration.vector.kind === 'qdrant';
    if (expectsOllama || profiles.includes('ollama')) {
      fail('local Ollama is unavailable until Seedbed can verify a separately supplied immutable model artifact selector and digest');
    }
    if (profiles.includes('qdrant') !== expectsQdrant) {
      fail('compose qdrant profile must exactly match the semantic vector kind');
    }
    if (expectsQdrant && semantic.configuration.vector.kind === 'qdrant' && semantic.configuration.vector.endpoint !== 'http://qdrant:6333') {
      fail('qdrant profile requires the exact internal http://qdrant:6333 endpoint');
    }
    if (
      semantic.configuration.provider.kind === 'openai-compatible'
      && semantic.configuration.provider.credentialSelector === null
    ) fail('openai-compatible semantic provider requires a protected credential selector');
    const referenced = [
      semantic.configuration.provider.credentialSelector,
      semantic.configuration.vector.kind === 'qdrant' ? semantic.configuration.vector.credentialSelector : null,
    ].filter((entry): entry is string => entry !== null);
    const declared = semantic.credentialSelectors.map(({ id }) => id);
    if (
      new Set(declared).size !== declared.length
      || canonicalJson([...new Set(referenced)].sort()) !== canonicalJson([...declared].sort())
    ) fail('semantic credential selectors must declare exactly the referenced protected selector IDs');
  } else if (profiles.includes('ollama') || profiles.includes('qdrant')) {
    fail('ollama/qdrant profiles require semantic configuration');
  }

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
    ...(semantic === undefined ? {} : { semantic }),
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

function semanticConfiguration(value: unknown): NonNullable<SeedbedConfig['semantic']> {
  const record = object(value, 'semantic');
  exactKeys(record, ['configuration', 'expectedRevision', 'credentialSelectors'], 'semantic');
  const input = object(record.configuration, 'semantic.configuration');
  exactKeys(input, ['version', 'id', 'name', 'provider', 'vector'], 'semantic.configuration');
  if (input.version !== 1) fail('semantic.configuration.version must be 1');
  const providerInput = object(input.provider, 'semantic.configuration.provider');
  exactKeys(providerInput, [
    'kind', 'endpoint', 'model', 'dimensions', 'metric', 'credentialSelector',
    'allowPrivateEndpoint', 'redirectPolicy',
  ], 'semantic.configuration.provider');
  if (!['openai-compatible', 'ollama-compatible'].includes(String(providerInput.kind))) fail('semantic provider kind is invalid');
  if (!['cosine', 'dot', 'euclid'].includes(String(providerInput.metric))) fail('semantic provider metric is invalid');
  if (typeof providerInput.allowPrivateEndpoint !== 'boolean') fail('semantic provider private endpoint approval must be boolean');
  if (providerInput.redirectPolicy !== 'error') fail('semantic provider redirect policy must be error');
  const providerCredential = nullableIdentifier(providerInput.credentialSelector, 'semantic provider credentialSelector');
  const provider: SemanticConfigurationV1['provider'] = {
    kind: providerInput.kind as SemanticConfigurationV1['provider']['kind'],
    endpoint: semanticEndpoint(providerInput.endpoint, 'semantic provider endpoint'),
    model: boundedToken(providerInput.model, 'semantic provider model', 256),
    dimensions: integer(providerInput.dimensions, 'semantic provider dimensions', 1, 65_536),
    metric: providerInput.metric as SemanticConfigurationV1['provider']['metric'],
    credentialSelector: providerCredential,
    allowPrivateEndpoint: providerInput.allowPrivateEndpoint,
    redirectPolicy: 'error',
  };
  requirePrivateApproval(provider.endpoint, provider.allowPrivateEndpoint, 'semantic provider');
  const vectorInput = object(input.vector, 'semantic.configuration.vector');
  let vector: SemanticConfigurationV1['vector'];
  if (vectorInput.kind === 'sqlite') {
    exactKeys(vectorInput, ['kind'], 'semantic.configuration.vector');
    vector = { kind: 'sqlite' };
  } else {
    exactKeys(vectorInput, [
      'kind', 'endpoint', 'collection', 'credentialSelector',
      'allowPrivateEndpoint', 'redirectPolicy',
    ], 'semantic.configuration.vector');
    if (vectorInput.kind !== 'qdrant') fail('semantic vector kind is invalid');
    if (typeof vectorInput.allowPrivateEndpoint !== 'boolean') fail('semantic vector private endpoint approval must be boolean');
    if (vectorInput.redirectPolicy !== 'error') fail('semantic vector redirect policy must be error');
    vector = {
      kind: 'qdrant',
      endpoint: semanticEndpoint(vectorInput.endpoint, 'semantic vector endpoint'),
      collection: boundedToken(vectorInput.collection, 'semantic vector collection', 128),
      credentialSelector: nullableIdentifier(vectorInput.credentialSelector, 'semantic vector credentialSelector'),
      allowPrivateEndpoint: vectorInput.allowPrivateEndpoint,
      redirectPolicy: 'error',
    };
    requirePrivateApproval(vector.endpoint, vector.allowPrivateEndpoint, 'semantic vector');
  }
  if (!Array.isArray(record.credentialSelectors) || record.credentialSelectors.length > 2) {
    fail('semantic credentialSelectors must be a bounded array');
  }
  const credentialSelectors = record.credentialSelectors.map((value, index) => {
    const selected = object(value, `semantic.credentialSelectors[${index}]`);
    exactKeys(selected, ['id', 'kind', 'path'], `semantic.credentialSelectors[${index}]`);
    if (selected.kind !== 'protected-file-v1') fail('semantic credentials must use protected-file-v1 selectors');
    return {
      id: boundedToken(selected.id, `semantic.credentialSelectors[${index}].id`, 256),
      kind: 'protected-file-v1' as const,
      path: safeAbsolutePath(selected.path, `semantic.credentialSelectors[${index}].path`),
    };
  });
  return {
    configuration: {
      version: 1,
      id: boundedToken(input.id, 'semantic configuration id', 128),
      name: boundedToken(input.name, 'semantic configuration name', 128),
      provider,
      vector,
    },
    expectedRevision: integer(record.expectedRevision, 'semantic.expectedRevision', 0, Number.MAX_SAFE_INTEGER),
    credentialSelectors,
  };
}

function semanticEndpoint(value: unknown, label: string): string {
  const url = new URL(text(value, label));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    fail(`${label} must be credential-free HTTP(S) without query credentials`);
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  const ipv4 = hostname.split('.').map(Number);
  const loopback = hostname === 'localhost'
    || hostname === '::1'
    || (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && ipv4[0] === 127);
  if (loopback) url.hostname = 'host.docker.internal';
  return url.href.replace(/\/$/u, '');
}

function requirePrivateApproval(endpointValue: string, approved: boolean, label: string): void {
  const url = new URL(endpointValue);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  const ipv4 = hostname.split('.').map(Number);
  const isIpv4 = ipv4.length === 4
    && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
  const loopback = hostname === 'localhost'
    || hostname === '::1'
    || (isIpv4 && ipv4[0] === 127);
  const pinnedHostGateway = hostname === 'host.docker.internal';
  const composePrivate = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(hostname)
    && !loopback;
  if (loopback || pinnedHostGateway || composePrivate) {
    if (!approved) fail(`${label} private endpoint requires explicit approval`);
    if (url.protocol !== 'http:') fail(`${label} approved local endpoint must use HTTP`);
    return;
  }
  fail(`${label} is not an explicitly approved loopback or Compose-private endpoint`);
}

function nullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : boundedToken(value, label, 256);
}

function boundedToken(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximum
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) fail(`${label} must be bounded nonblank text`);
  return value;
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
  return url.href.replace(/\/+$/u, '');
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

import { webcrypto } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMigrationAssemblyAuthorityV1,
} from '@gnolith/diamond';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import {
  createAuthorizationCursorCodec,
  createTaprootHostWriteCapability,
} from '@gnolith/taproot';
import {
  createLocalFilesystemResourceBlobPortsV1,
} from '@gnolith/workshop/backup';
import {
  createWorkshopLocalExecutableAdapterFromPrimitivesV1,
} from '@gnolith/workshop/local-adapter';
import { verifyWaystoneAssetMount } from '@gnolith/workshop/server';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ASSEMBLY_CONFIG_PATH = resolve(ROOT, 'assembly.config.json');
let adapterPromise;

export async function createWorkshopExecutable(config, protectedReader) {
  const adapter = await localAdapter(config, protectedReader);
  return adapter.createWorkshopExecutable(config, protectedReader);
}

export async function createWorkshopBootstrapDependencies(config, protectedReader) {
  const adapter = await localAdapter(config, protectedReader);
  if (!adapter.createWorkshopBootstrapDependencies) {
    throw new TypeError('Packed Workshop local adapter does not support bootstrap-v1');
  }
  return adapter.createWorkshopBootstrapDependencies(config, protectedReader);
}

export async function createWorkshopSemanticConfigurationDependencies(config, protectedReader) {
  const adapter = await localAdapter(config, protectedReader);
  if (!adapter.createWorkshopSemanticConfigurationDependencies) {
    throw new TypeError('Packed Workshop local adapter does not support semantic configuration');
  }
  return adapter.createWorkshopSemanticConfigurationDependencies(config, protectedReader);
}

function localAdapter(config, protectedReader) {
  adapterPromise ??= assemble(config, protectedReader);
  return adapterPromise;
}

async function assemble(config, protectedReader) {
  const assembly = await readAssemblyConfig();
  if (
    config.authentication?.profile !== 'local-bearer-v1'
    || config.authentication.credentialStore?.kind !== 'file'
  ) {
    throw new TypeError('Seedbed local assembly requires a protected local bearer file');
  }
  const protectedBytes = await protectedReader(config.authentication.credentialStore);
  if (!(protectedBytes instanceof Uint8Array) || protectedBytes.byteLength === 0 || protectedBytes.byteLength > 1024) {
    throw new TypeError('Protected local assembly key material is invalid');
  }
  const db = new NodeSqliteDatabase(assembly.databasePath);
  try {
    const [
      hostAuthorityKey,
      authorizationCursorKey,
      cursorEncryptionKey,
      cursorDigestKey,
      blobs,
    ] = await Promise.all([
      deriveKey(protectedBytes, assembly.installationId, 'taproot-host-authority-v1', 'hmac'),
      deriveKey(protectedBytes, assembly.installationId, 'taproot-authorization-cursor-v1', 'aes'),
      deriveKey(protectedBytes, assembly.installationId, 'workshop-cursor-encryption-v1', 'aes'),
      deriveKey(protectedBytes, assembly.installationId, 'workshop-cursor-digest-v1', 'hmac'),
      createLocalFilesystemResourceBlobPortsV1({
        root: assembly.blobRoot,
        maxBlobBytes: assembly.maxBlobBytes,
        maxEntries: 10_000,
      }),
    ]);
    protectedBytes.fill(0);
    if (!blobs.payloadStore || blobs.payloadStore.kind !== 'taproot-resource-payload-store-v1') {
      throw new TypeError('Packed Workshop blob factory does not expose its sealed payload store');
    }
    const hostAuthority = createTaprootHostWriteCapability(
      db,
      { baseIri: assembly.baseIri },
      hostAuthorityKey,
    );
    const adapter = await createWorkshopLocalExecutableAdapterFromPrimitivesV1({
      kind: 'workshop-local-assembly-primitives-v1',
      version: '0.5.0',
      db,
      installationId: assembly.installationId,
      registrationFingerprint: assembly.registrationFingerprint,
      taproot: {
        options: { baseIri: assembly.baseIri },
        hostAuthority,
        authorizationCursorCodec: createAuthorizationCursorCodec(authorizationCursorKey),
        registrationPrincipal: {
          principalId: assembly.principalId,
          activeWorkspaceId: assembly.workspaceId,
        },
        payloadStore: blobs.payloadStore,
        maxHydratedResourceBytes: assembly.maxBlobBytes,
      },
      cursor: {
        generation: assembly.cursorGeneration,
        encryptionKey: cursorEncryptionKey,
        digestKey: cursorDigestKey,
      },
      migrationAssemblyAuthority: createMigrationAssemblyAuthorityV1(db, assembly.installationId),
      assets: verifyConfiguredAssets,
      semantic: {
        resolveCredential: (selector) => readSemanticCredential(assembly, selector),
      },
      dependencies: [{ close: () => db.close() }],
    });
    return adapter;
  } catch (error) {
    protectedBytes.fill(0);
    await db.close().catch(() => undefined);
    throw error;
  }
}

async function readSemanticCredential(assembly, selector) {
  if (
    typeof selector !== 'string'
    || !Object.prototype.hasOwnProperty.call(assembly.semanticCredentialFiles, selector)
  ) throw new TypeError('Semantic credential selector is not configured by Seedbed');
  const target = assembly.semanticCredentialFiles[selector];
  const metadata = await lstat(target);
  const canonical = resolve(await realpath(target));
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || canonical !== target
    || metadata.size < 1
    || metadata.size > 1024 * 1024
  ) throw new TypeError('Semantic credential selector must resolve to a bounded direct regular file');
  const bytes = await readFile(target);
  try {
    return decodeCanonicalTextSecret(bytes);
  } finally {
    bytes.fill(0);
  }
}

function decodeCanonicalTextSecret(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 1024 * 1024) {
    throw new TypeError('Protected text secret must contain bounded nonempty UTF-8');
  }
  let value;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError('Protected text secret must contain bounded nonempty UTF-8');
  }
  if (value.endsWith('\r\n')) value = value.slice(0, -2);
  else if (value.endsWith('\n')) value = value.slice(0, -1);
  if (
    value.length === 0
    || /^[\s]/u.test(value)
    || /[\s]$/u.test(value)
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new TypeError('Protected text secret has noncanonical surrounding or control bytes');
  return value;
}

async function verifyConfiguredAssets(config, protectedReader) {
  if (!config.assetMount) return undefined;
  if (
    config.assetMount.root?.kind !== 'file'
    || typeof config.assetMount.root.value !== 'string'
    || config.assetMount.manifest?.kind !== 'file'
  ) throw new TypeError('Waystone local asset selectors must be protected file selectors');
  const root = resolve(config.assetMount.root.value);
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || resolve(await realpath(root)) !== root) {
    throw new TypeError('Waystone local asset root must be a real directory');
  }
  const manifestBytes = await protectedReader(config.assetMount.manifest);
  if (manifestBytes.byteLength > 8 * 1024 * 1024) throw new TypeError('Waystone asset manifest exceeds 8 MiB');
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    throw new TypeError('Waystone asset manifest must be bounded UTF-8 JSON');
  }
  return verifyWaystoneAssetMount({
    prefix: config.assetMount.prefix,
    manifest,
    source: {
      async read(path) {
        if (!safeAssetPath(path)) return null;
        const target = resolve(root, ...path.split('/'));
        const inside = relative(root, target);
        if (!inside || inside.startsWith('..') || inside.includes(':')) return null;
        try {
          const entry = await lstat(target);
          if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 64 * 1024 * 1024) return null;
          const canonical = resolve(await realpath(target));
          if (canonical !== target || relative(root, canonical).startsWith('..')) return null;
          return { bytes: await readFile(target), symlink: false };
        } catch {
          return null;
        }
      },
    },
  });
}

function safeAssetPath(path) {
  return typeof path === 'string'
    && path.length > 0
    && path.length <= 1024
    && !path.startsWith('/')
    && !path.includes('\\')
    && !path.includes('?')
    && !path.includes('#')
    && path.split('/').every((part) => part && part !== '.' && part !== '..');
}

async function readAssemblyConfig() {
  const bytes = await readFile(ASSEMBLY_CONFIG_PATH);
  if (bytes.byteLength > 1024 * 1024) throw new TypeError('Seedbed assembly config is too large');
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError('Seedbed assembly config must be bounded UTF-8 JSON');
  }
  const expectedKeys = [
    'format',
    'installationId',
    'baseIri',
    'databasePath',
    'blobRoot',
    'principalId',
    'workspaceId',
    'registrationFingerprint',
    'cursorGeneration',
    'maxBlobBytes',
    'semanticCredentialFiles',
  ].sort();
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)
    || value.format !== 'gnolith-seedbed-local-assembly-v1'
  ) throw new TypeError('Seedbed assembly config fields are invalid');
  for (const key of ['installationId', 'baseIri', 'databasePath', 'blobRoot', 'principalId', 'workspaceId', 'cursorGeneration']) {
    if (typeof value[key] !== 'string' || value[key].length === 0 || value[key].length > 2048) {
      throw new TypeError(`Seedbed assembly config ${key} is invalid`);
    }
  }
  if (
    typeof value.registrationFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.registrationFingerprint)
    || !Number.isSafeInteger(value.maxBlobBytes)
    || value.maxBlobBytes < 1
    || value.maxBlobBytes > 1024 * 1024 * 1024
  ) throw new TypeError('Seedbed assembly config digest or blob bound is invalid');
  if (
    !value.semanticCredentialFiles
    || typeof value.semanticCredentialFiles !== 'object'
    || Array.isArray(value.semanticCredentialFiles)
    || Object.keys(value.semanticCredentialFiles).length > 2
  ) throw new TypeError('Seedbed semantic credential selector mapping is invalid');
  for (const [selector, target] of Object.entries(value.semanticCredentialFiles)) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(selector)
      || typeof target !== 'string'
      || !/^\/run\/secrets\/gnolith-semantic-[0-9a-f]{16}$/u.test(target)
    ) throw new TypeError('Seedbed semantic credential selector mapping is invalid');
  }
  if (!value.databasePath.startsWith('/var/lib/gnolith/') || !value.blobRoot.startsWith('/var/lib/gnolith/')) {
    throw new TypeError('Seedbed assembly storage paths must remain in the application-data volume');
  }
  return value;
}

async function deriveKey(secret, installationId, label, kind) {
  const material = await webcrypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  const params = {
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new TextEncoder().encode(installationId),
    info: new TextEncoder().encode(label),
  };
  return webcrypto.subtle.deriveKey(
    params,
    material,
    kind === 'aes'
      ? { name: 'AES-GCM', length: 256 }
      : { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    kind === 'aes' ? ['encrypt', 'decrypt'] : ['sign', 'verify'],
  );
}

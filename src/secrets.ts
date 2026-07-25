import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, normalize } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256 } from './canonical.js';

export interface BearerCredentialMetadata {
  readonly credentialId: string;
  readonly credentialDigest: string;
  readonly protectedFile: string;
  readonly requiredEnvironmentSelector: 'GNOLITH_BEARER_TOKEN';
}

export function decodeCanonicalTextSecret(
  input: Uint8Array | string,
  maximumBytes = 1024 * 1024,
): string {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
    throw new TypeError('Protected text secret must contain bounded nonempty UTF-8');
  }
  let value: string;
  try {
    value = typeof input === 'string'
      ? input
      : new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    throw new TypeError('Protected text secret must contain bounded nonempty UTF-8');
  }
  if (value.endsWith('\n')) value = value.slice(0, -1);
  if (
    value.length === 0
    || /^[\s]/u.test(value)
    || /[\s]$/u.test(value)
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError('Protected text secret has noncanonical surrounding or control bytes');
  }
  return value;
}

export async function createLocalBearerCredential(
  credentialId: string,
  path: string,
  options: { platform?: NodeJS.Platform; random?: (bytes: number) => Buffer; windowsAcl?: (path: string) => void } = {},
): Promise<BearerCredentialMetadata> {
  if (!isAbsolute(path) || /^\\\\/u.test(path)) throw new TypeError('Credential path must be an absolute local path');
  await ensureProtectedParents(dirname(path));
  const platform = options.platform ?? process.platform;
  const bytes = (options.random ?? randomBytes)(32);
  if (bytes.byteLength !== 32) throw new TypeError('Credential generator must return exactly 32 bytes');
  const token = bytes.toString('base64url');
  bytes.fill(0);
  let created = false;
  try {
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    created = true;
    try {
      await handle.writeFile(token, { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (platform === 'win32') {
      (options.windowsAcl ?? applyWindowsAcl)(path);
    } else {
      await chmod(path, 0o600);
    }
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new TypeError('Credential file is not a regular protected file');
    if (platform !== 'win32' && (metadata.mode & 0o077) !== 0) throw new TypeError('Credential file permissions are not owner-only');
    return {
      credentialId,
      credentialDigest: sha256(token),
      protectedFile: normalize(path),
      requiredEnvironmentSelector: 'GNOLITH_BEARER_TOKEN',
    };
  } catch (error) {
    if (created) await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function inspectProtectedCredential(path: string, platform: NodeJS.Platform = process.platform): Promise<{ credentialDigest: string }> {
  if (!isAbsolute(path) || /^\\\\/u.test(path)) throw new TypeError('Credential path must be an absolute local path');
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new TypeError('Credential selector must identify a regular non-link file');
  if (metadata.size !== 43 && metadata.size !== 44) {
    throw new TypeError('Credential file must contain exactly 43 base64url bytes with at most one trailing LF');
  }
  if (platform !== 'win32' && (metadata.mode & 0o077) !== 0) throw new TypeError('Credential file permissions are not owner-only');
  const encoded = await readFile(path);
  const token = decodeCanonicalTextSecret(encoded, 44);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new TypeError('Credential file encoding is not canonical base64url without padding');
  if (Buffer.from(token, 'base64url').byteLength !== 32) throw new TypeError('Credential file does not encode exactly 32 bytes');
  return { credentialDigest: sha256(token) };
}

async function ensureProtectedParents(path: string): Promise<void> {
  const missing: string[] = [];
  let cursor = normalize(path);
  while (true) {
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new TypeError('Credential parent must be a real directory, not a link or junction');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) throw new TypeError('Credential parent has no existing local root');
      cursor = parent;
    }
  }
  for (const directory of missing.reverse()) {
    await mkdir(directory, { mode: 0o700 });
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new TypeError('Credential parent creation was redirected');
  }
  const resolved = await realpath(path);
  if (normalize(resolved) !== normalize(path)) throw new TypeError('Credential parent resolved through an ambiguous link or junction');
}

function applyWindowsAcl(path: string): void {
  const user = process.env.USERNAME;
  if (!user || !/^[^"<>|?*\r\n]{1,128}$/u.test(user)) throw new TypeError('Cannot determine a safe Windows credential owner');
  execFileSync('icacls.exe', [path, '/inheritance:r', '/grant:r', `${user}:(R,W)`], {
    windowsHide: true,
    stdio: 'ignore',
  });
}

import { lstat, open, readFile } from 'node:fs/promises';
import { constants, readSync } from 'node:fs';
import { subtle, type webcrypto } from 'node:crypto';
import type { SeedbedConfig } from './config.js';
import { ExitCode, SeedbedError } from './errors.js';

const encoder = new TextEncoder();

export interface InstallationKeys {
  readonly binding: webcrypto.CryptoKey;
  readonly hostWrite: webcrypto.CryptoKey;
  readonly cursorAead: webcrypto.CryptoKey;
  readonly cursorDigest: webcrypto.CryptoKey;
  readonly taprootCursorAead: webcrypto.CryptoKey;
}

export async function deriveInstallationKeys(config: SeedbedConfig, installationId: string): Promise<InstallationKeys> {
  const raw = await readRootSecret(config);
  try {
    const material = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    const derive = (info: string, algorithm: webcrypto.AesKeyGenParams | webcrypto.HmacImportParams, usages: webcrypto.KeyUsage[]) =>
      subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(`@gnolith/seedbed/${installationId}`), info: encoder.encode(info) },
        material,
        algorithm,
        false,
        usages,
      );
    const [binding, hostWrite, cursorAead, cursorDigest, taprootCursorAead] = await Promise.all([
      derive('installation-binding/v1', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign', 'verify']),
      derive('taproot-host-write/v1', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign', 'verify']),
      derive('workshop-cursor-aead/v1', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
      derive('workshop-cursor-digest/v1', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign', 'verify']),
      derive('taproot-cursor-aead/v1', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    ]);
    return { binding, hostWrite, cursorAead, cursorDigest, taprootCursorAead };
  } finally {
    raw.fill(0);
  }
}

async function readRootSecret(config: SeedbedConfig): Promise<Uint8Array> {
  if ((config.rootSecretFile === undefined) === (config.rootSecretFd === undefined)) {
    throw secretError('Configure exactly one root-secret file or inherited file descriptor');
  }
  let bytes: Uint8Array;
  if (config.rootSecretFile !== undefined) {
    const metadata = await lstat(config.rootSecretFile);
    if (metadata.isSymbolicLink()) throw secretError('Root-secret selector must not identify a symbolic link');
    if (!metadata.isFile()) throw secretError('Root-secret selector must identify a regular file');
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
      throw secretError('Root-secret file must not be accessible by group or others');
    }
    const handle = await open(config.rootSecretFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) throw secretError('Root-secret selector must identify a regular file');
      if (process.platform !== 'win32' && (opened.mode & 0o077) !== 0) {
        throw secretError('Root-secret file must not be accessible by group or others');
      }
      if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
        throw secretError('Root-secret file changed while it was being opened');
      }
      bytes = await readFile(handle);
    } finally {
      await handle.close();
    }
  } else {
    const buffer = Buffer.alloc(33);
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(config.rootSecretFd!, buffer, count, buffer.length - count, null);
      if (read === 0) break;
      count += read;
    }
    bytes = buffer.subarray(0, count);
  }
  if (bytes.byteLength !== 32) {
    bytes.fill(0);
    throw secretError('Root-secret source must contain exactly 32 bytes');
  }
  return bytes;
}

function secretError(message: string): SeedbedError {
  return new SeedbedError(message, ExitCode.configuration, 'invalid_root_secret');
}

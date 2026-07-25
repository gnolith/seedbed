import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function digestObject(value: unknown): string {
  return sha256(canonicalJson(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, sortValue(record[key])]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('Canonical JSON cannot encode non-finite numbers');
  }
  return value;
}

export function assertLowerSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be lowercase hexadecimal SHA-256`);
  }
}

export function redactFilesystemPaths(value: string): string {
  return value.replaceAll(
    /(?:[A-Za-z]:[\\/][^\s"']+|(?<![A-Za-z0-9@._-])\/[^\s"']+)/gu,
    '[redacted-path]',
  );
}

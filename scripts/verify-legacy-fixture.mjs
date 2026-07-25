import { createHash } from 'node:crypto';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

const decompress = promisify(gunzip);
const root = new URL('../fixtures/legacy-local-v1/', import.meta.url);
const evidence = JSON.parse(await readFile(new URL('fixture-evidence.json', root), 'utf8'));
const compressed = await readFile(new URL(evidence.snapshot.path, root));
if (compressed.byteLength !== evidence.snapshot.bytes || digest(compressed) !== evidence.snapshot.sha256) {
  throw new Error('Frozen legacy fixture snapshot bytes do not match their evidence');
}
const expanded = await decompress(compressed);
if (expanded.byteLength > 192 * 1024 * 1024) throw new Error('Frozen legacy fixture expands beyond its bound');
const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(expanded));
if (
  envelope?.manifest?.format !== 'gnolith-seedbed-snapshot-v1'
  || envelope.manifest.installationId !== evidence.snapshot.installationId
  || envelope.manifest.baseIri !== evidence.snapshot.baseIri
  || envelope.manifest.secretsExported !== false
  || JSON.stringify(envelope.manifest.packages) !== JSON.stringify({
    diamond: '0.4.1',
    taproot: '0.4.2',
    workshop: '0.4.2',
    seedbed: '0.3.2',
  })
) throw new Error('Frozen legacy fixture manifest is incompatible');
const database = canonicalBase64(envelope.database, 'database');
if (
  database.byteLength !== evidence.snapshot.databaseBytes
  || digest(database) !== evidence.snapshot.databaseSha256
) throw new Error('Frozen legacy fixture database evidence does not match');
if (
  !Array.isArray(envelope.blobs)
  || envelope.blobs.length !== evidence.payloads.length
  || envelope.blobs.some((blob, index) => {
    const expected = evidence.payloads[index];
    const bytes = canonicalBase64(blob.data, `blob ${index}`);
    return blob.path !== expected.id
      || bytes.byteLength !== expected.bytes
      || digest(bytes) !== expected.sha256;
  })
) throw new Error('Frozen legacy fixture payload evidence does not match');
if (
  evidence.dispositions.semanticConfiguration.count !== 0
  || evidence.dispositions.onboarding.count !== 0
  || evidence.dispositions.onboarding.disposition !== 'unavailable-in-public-legacy-api'
) throw new Error('Frozen legacy unsupported dispositions are not explicit');
console.log(`verified frozen public legacy fixture ${evidence.snapshot.sha256}`);

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalBase64(value, label) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error(`Frozen legacy fixture ${label} is not canonical base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error(`Frozen legacy fixture ${label} is not canonical base64`);
  return bytes;
}

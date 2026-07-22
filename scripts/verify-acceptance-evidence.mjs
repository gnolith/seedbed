import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const expected = ['A01', 'D02', 'D05', 'G07', 'H05', 'H06', 'H07', 'H08', 'I05', 'I08', 'I16', 'I17'];
const path = new URL('../docs/acceptance-evidence.json', import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const evidence = JSON.parse(await readFile(path, 'utf8'));
if (evidence.version !== 1 || evidence.scope !== 'seedbed-owned-requirements' || evidence.authoritativeParentLedger !== 'gnolith/seedbed#15') throw new Error('acceptance evidence identity is invalid');
if (!Array.isArray(evidence.entries) || evidence.entries.length !== expected.length) throw new Error('acceptance evidence must contain exactly twelve owned rows');
const ids = evidence.entries.map(({ id }) => id);
if (JSON.stringify(ids) !== JSON.stringify(expected)) throw new Error(`acceptance evidence IDs/order are ${JSON.stringify(ids)}`);
for (const entry of evidence.entries) {
  if (!['pending', 'partial', 'complete'].includes(entry.status)) throw new Error(`${entry.id} has invalid status`);
  if (!Array.isArray(entry.proofs) || entry.proofs.length === 0 || !entry.blockingCommand?.trim()) throw new Error(`${entry.id} lacks a blocking proof`);
  for (const proof of entry.proofs) {
    if (typeof proof !== 'string' || proof.startsWith('/') || proof.includes('..')) throw new Error(`${entry.id} has unsafe proof path`);
    await access(resolve(root, proof));
  }
  if (entry.status !== 'complete' && !entry.remaining?.trim()) throw new Error(`${entry.id} must name its remaining gate`);
  if (entry.status === 'complete' && entry.remaining) throw new Error(`${entry.id} complete status contradicts a remaining gate`);
}
process.stdout.write(`verified ${expected.length} Seedbed-owned acceptance evidence rows\n`);

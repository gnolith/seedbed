import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLocalBearerCredential } from '../dist/secrets.js';

const root = await mkdtemp(join(tmpdir(), 'seedbed-canary-'));
const canary = randomBytes(32);
const encoded = canary.toString('base64url');
canary.fill(0);
const path = join(root, 'bearer');
try {
  const metadata = await createLocalBearerCredential('canary-credential', path, {
    random: () => Buffer.from(encoded, 'base64url'),
    windowsAcl: () => undefined,
  });
  const serialized = JSON.stringify(metadata);
  if (serialized.includes(encoded)) throw new Error('credential metadata contains secret bytes');
  if ((await readFile(path, 'utf8')) !== encoded) throw new Error('generated protected credential must be canonical newline-free text');
  for (const path of ['package.json', 'compose/compose.yaml', 'docker/local-build.Dockerfile']) {
    if ((await readFile(path, 'utf8')).includes(encoded)) throw new Error(`secret canary leaked to ${path}`);
  }
  console.log('verified protected credential canary isolation');
} finally {
  await rm(root, { recursive: true, force: true });
}

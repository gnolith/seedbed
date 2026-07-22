import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const extractor = fileURLToPath(new URL('../scripts/extract-release-artifact.py', import.meta.url));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('retained release artifact ZIP extraction', () => {
  it('extracts an exact nested allowlisted inventory into an isolated directory', async () => {
    const fixture = await makeFixture('valid');
    const result = extract(fixture);
    expect(result.status).toBe(0);
    expect(await readFile(join(fixture.destination, 'docs', 'evidence.json'), 'utf8')).toBe('trusted evidence\n');
  });

  it.each([
    ['traversal', 'traversal or an empty path component'],
    ['duplicate', 'duplicate or colliding paths'],
    ['casefold', 'duplicate or colliding paths'],
    ['non-nfc', 'non-NFC path'],
    ['symlink', 'symlink or special'],
    ['zip-bomb', 'expansion bound exceeded'],
  ] as const)('rejects %s archives before publication', async (mode, message) => {
    const fixture = await makeFixture(mode);
    const result = extract(fixture);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(message);
  });

  it('rejects raw archive bytes that do not match the Actions service digest', async () => {
    const fixture = await makeFixture('valid');
    const plan = JSON.parse(await readFile(fixture.plan, 'utf8')) as RecoveryPlan;
    plan.artifacts[0]!.digest = `sha256:${'0'.repeat(64)}`;
    await writeFile(fixture.plan, JSON.stringify(plan));
    const result = extract(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('service digest mismatch');
  });
});

async function makeFixture(mode: FixtureMode): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'seedbed-release-archive-'));
  roots.push(root);
  const archive = join(root, 'artifact.zip');
  const manifest = join(root, 'fixture.json');
  const plan = join(root, 'plan.json');
  const destination = join(root, 'extracted');
  const entries = entriesFor(mode);
  await writeFile(manifest, JSON.stringify({ entries, mode }));
  const created = spawnSync('python', ['-c', zipFixtureSource, manifest, archive], { encoding: 'utf8' });
  expect(created.status, created.stderr).toBe(0);
  const archiveBytes = await readFile(archive);
  const inventory = entries.map(({ data, name }) => {
    const bytes = Buffer.from(data, 'base64');
    return {
      path: `fixture/${name}`,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
  const recoveryPlan: RecoveryPlan = {
    artifacts: [{
      digest: `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`,
      directory: 'fixture',
      size: (await stat(archive)).size,
    }],
    inventory,
  };
  await writeFile(plan, JSON.stringify(recoveryPlan));
  return { archive, destination, plan };
}

function extract({ archive, destination, plan }: Fixture) {
  return spawnSync('python', [extractor, plan, '0', archive, destination], { encoding: 'utf8' });
}

function entriesFor(mode: FixtureMode): FixtureEntry[] {
  const encoded = (value: string) => Buffer.from(value).toString('base64');
  if (mode === 'valid') return [{ name: 'docs/evidence.json', data: encoded('trusted evidence\n') }];
  if (mode === 'traversal') return [{ name: '../escape.txt', data: encoded('escape') }];
  if (mode === 'duplicate') return [
    { name: 'same.txt', data: encoded('same') },
    { name: 'same.txt', data: encoded('same') },
  ];
  if (mode === 'casefold') return [
    { name: 'Evidence.json', data: encoded('first') },
    { name: 'evidence.json', data: encoded('second') },
  ];
  if (mode === 'non-nfc') return [{ name: 'e\u0301vidence.json', data: encoded('evidence') }];
  if (mode === 'symlink') return [{ name: 'link', data: encoded('target') }];
  return [{ name: 'large.txt', data: Buffer.alloc(1_000_000).toString('base64') }];
}

const zipFixtureSource = String.raw`
import base64, json, stat, sys, warnings, zipfile
manifest_path, archive_path = sys.argv[1:]
fixture = json.load(open(manifest_path, encoding='utf-8'))
with warnings.catch_warnings():
    warnings.simplefilter('ignore')
    with zipfile.ZipFile(archive_path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for entry in fixture['entries']:
            info = zipfile.ZipInfo(entry['name'])
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            if fixture['mode'] == 'symlink':
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, base64.b64decode(entry['data']))
`;

type FixtureMode = 'casefold' | 'duplicate' | 'non-nfc' | 'symlink' | 'traversal' | 'valid' | 'zip-bomb';
type FixtureEntry = { data: string; name: string };
type Fixture = { archive: string; destination: string; plan: string };
type RecoveryPlan = {
  artifacts: Array<{ digest: string; directory: string; size: number }>;
  inventory: Array<{ bytes: number; path: string; sha256: string }>;
};

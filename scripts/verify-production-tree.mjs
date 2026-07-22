import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const mode = process.argv[2];
const target = resolve(process.argv[3] ?? '.');

if (mode === '--archive') {
  const listing = spawnSync('tar', ['-tzf', target], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listing.error || listing.status !== 0) {
    throw new Error(`cannot inspect closure archive: ${listing.error?.message ?? listing.stderr}`);
  }
  const seen = new Set();
  for (const raw of listing.stdout.split('\n')) {
    if (!raw) continue;
    const path = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    assertSafeRelativePath(path);
    if (seen.has(path)) throw new Error(`duplicate archive path: ${path}`);
    seen.add(path);
  }
  if (seen.size === 0) throw new Error('closure archive is empty');
  process.exit(0);
}

const manifestPath = join(target, 'production-files.json');
const entries = await collectTree(target);
const serialized = `${JSON.stringify(entries, null, 2)}\n`;
if (mode === '--write') {
  await writeFile(manifestPath, serialized, { mode: 0o644 });
} else if (mode === '--verify') {
  const expected = await readFile(manifestPath, 'utf8');
  if (expected !== serialized) throw new Error('extracted production tree differs from its complete manifest');
} else {
  throw new Error('usage: verify-production-tree.mjs --archive ARCHIVE | --write ROOT | --verify ROOT');
}

async function collectTree(root) {
  const entries = [];
  await visit('');
  return entries;

  async function visit(relativePath) {
    const names = await readdir(join(root, relativePath));
    names.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    for (const name of names) {
      const path = relativePath ? `${relativePath}/${name}` : name;
      if (path === 'production-files.json' || path === 'production-closure.tar.gz') continue;
      assertSafeRelativePath(path);
      const absolutePath = join(root, ...path.split('/'));
      const stat = await lstat(absolutePath);
      const entry = { path, mode: stat.mode & 0o777 };
      if (stat.isDirectory()) {
        entries.push({ ...entry, type: 'directory' });
        await visit(path);
      } else if (stat.isFile()) {
        const digest = createHash('sha256').update(await readFile(absolutePath)).digest('hex');
        entries.push({ ...entry, type: 'file', sha256: digest });
      } else if (stat.isSymbolicLink()) {
        const link = await readlink(absolutePath);
        if (isAbsolute(link) || link.includes('\\') || /[\u0000-\u001f\u007f]/u.test(link)) {
          throw new Error(`unsafe symlink target for ${path}`);
        }
        const resolvedTarget = resolve(join(absolutePath, '..'), link);
        const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
        if (resolvedTarget !== root && !resolvedTarget.startsWith(rootPrefix)) {
          throw new Error(`symlink escapes production root: ${path} -> ${link}`);
        }
        entries.push({ ...entry, type: 'symlink', target: link });
      } else {
        throw new Error(`unsupported filesystem entry in closure: ${path}`);
      }
    }
  }
}

function assertSafeRelativePath(path) {
  if (!path || isAbsolute(path) || path.includes('\\') || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new Error(`unsafe closure path: ${JSON.stringify(path)}`);
  }
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`unsafe closure path: ${JSON.stringify(path)}`);
  }
  const normalized = relative('.', path).replaceAll('\\', '/');
  if (normalized !== path) throw new Error(`non-canonical closure path: ${JSON.stringify(path)}`);
}

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
const pack = JSON.parse(runNpm(['pack', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
const filename = resolve(pack[0].filename);
const listing = execFileSync('tar', ['-tzf', filename], { encoding: 'utf8' });
for (const required of ['package/dist/cli.js', 'package/compose/compose.yaml', 'package/docker/local-build.Dockerfile', 'package/migration-order.json']) {
  if (!listing.includes(required)) throw new Error(`packed artifact missing ${required}`);
}
for (const forbidden of ['dist/mcp.js', 'dist/runtime.js', 'dist/authorization.js', 'dist/snapshot.js', '.github/workflows/release.yml', 'node_modules/']) {
  if (listing.includes(forbidden)) throw new Error(`packed artifact contains removed surface ${forbidden}`);
}
const fixture = await mkdtemp(join(tmpdir(), 'seedbed-packed-'));
try {
  runNpm(['init', '--yes'], { cwd: fixture, stdio: 'ignore' });
  runNpm(['install', '--ignore-scripts', filename], { cwd: fixture, stdio: 'ignore' });
  const cli = join(fixture, 'node_modules', '@gnolith', 'seedbed', 'dist', 'cli.js');
  const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  if (!help.includes('adopt legacy-local plan') || /\b(?:stdio|tools|call|serve)\b/u.test(help)) throw new Error('packed CLI command surface is invalid');
  const lock = await readFile(join(fixture, 'package-lock.json'), 'utf8');
  if (/@modelcontextprotocol|@gnolith\/(?:diamond|taproot|workshop)/u.test(lock)) throw new Error('packed consumer has a forbidden runtime dependency');
  console.log('verified packed installation-only consumer');
} finally {
  await rm(fixture, { recursive: true, force: true });
  await rm(filename, { force: true });
}

function runNpm(args, options) {
  if (!process.env.npm_execpath) throw new Error('packed test must run through npm');
  return execFileSync(process.execPath, [process.env.npm_execpath, ...args], options);
}

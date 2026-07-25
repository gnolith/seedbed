import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
const pack = JSON.parse(runNpm(['pack', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
const filename = resolve(pack[0].filename);
const listing = execFileSync('tar', ['-tzf', filename], { encoding: 'utf8' });
for (const required of ['package/dist/cli.js', 'package/compose/compose.yaml', 'package/docker/local-build.Dockerfile', 'package/migration-order.json', 'package/seedbed-assembly-attestation.json']) {
  if (!listing.includes(required)) throw new Error(`packed artifact missing ${required}`);
}
for (const forbidden of ['dist/mcp.js', 'dist/runtime.js', 'dist/authorization.js', 'dist/snapshot.js', '.github/workflows/release.yml', 'node_modules/']) {
  if (listing.includes(forbidden)) throw new Error(`packed artifact contains removed surface ${forbidden}`);
}
const fixture = await mkdtemp(join(tmpdir(), 'seedbed-packed-'));
const stateRoot = await mkdtemp(join(tmpdir(), 'seedbed-packed-state-'));
try {
  runNpm(['init', '--yes'], { cwd: fixture, stdio: 'ignore' });
  runNpm(['install', '--ignore-scripts', filename], { cwd: fixture, stdio: 'ignore' });
  const cli = join(fixture, 'node_modules', '@gnolith', 'seedbed', 'dist', 'cli.js');
  const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  if (!help.includes('adopt legacy-local plan') || /\b(?:stdio|tools|call|serve)\b/u.test(help)) throw new Error('packed CLI command surface is invalid');
  const lock = await readFile(join(fixture, 'package-lock.json'), 'utf8');
  if (/@modelcontextprotocol|@gnolith\/(?:diamond|taproot|workshop)/u.test(lock)) throw new Error('packed consumer has a forbidden runtime dependency');
  const installedRoot = join(fixture, 'node_modules', '@gnolith', 'seedbed');
  const declaration = await readFile(join(installedRoot, 'dist', 'local-control.d.ts'), 'utf8');
  for (const term of ['SeedbedLocalBuildSelection', 'DigestQualifiedPulledImageSelection', 'componentLockSha256', 'graphSha256', 'composeBundleSha256']) {
    if (!declaration.includes(term)) throw new Error(`packed local-control declarations omit ${term}`);
  }
  const localControl = await import(pathToFileURL(join(installedRoot, 'dist', 'local-control.js')).href);
  const policy = localControl.defaultSeedbedControlPolicy({
    projectRoot: fixture,
    stateRoot,
    artifactRoot: installedRoot,
  });
  if (
    policy.localBuild.kind !== 'seedbed-local-build-v1'
    || policy.localBuild.selector !== localControl.SEEDBED_LOCAL_BUILD_SELECTOR
    || policy.localBuild.pullPolicy !== 'never'
  ) throw new Error('packed local-build selection is not exact and pull-free');
  const componentLock = JSON.parse(await readFile(join(installedRoot, 'seedbed-component-lock.json'), 'utf8'));
  const request = {
    installationId: 'packed-cross-boundary',
    baseIri: 'https://packed.invalid/installation',
    endpoint: 'http://127.0.0.1:4317/mcp',
    image: policy.localBuild,
    expected: {
      installationId: 'packed-cross-boundary',
      baseIri: 'https://packed.invalid/installation',
      serverVersion: componentLock.packages.workshop.version,
      operationVersion: componentLock.migrations.workshop,
      catalogDigest: componentLock.migrations.expectedCatalogDigest,
      migrationReady: true,
      canonicalReady: true,
      authorizationReady: true,
      lexicalReady: true,
      blobReady: true,
      producerStatus: 'ready',
      semanticState: 'absent',
      allowLexicalOnly: true,
    },
  };
  const control = localControl.createDefaultSeedbedControl({
    projectRoot: fixture,
    stateRoot,
    artifactRoot: installedRoot,
  });
  const plan = await control.plan(request);
  if (JSON.stringify(plan.request.image) !== JSON.stringify(policy.localBuild)) throw new Error('packed plan omitted local-build attestations');
  for (const field of ['componentLockSha256', 'graphSha256', 'composeBundleSha256']) {
    let rejected = false;
    try {
      await control.plan({ ...request, image: { ...request.image, [field]: 'f'.repeat(64) } });
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`packed local-build plan accepted tampered ${field}`);
  }
  console.log('verified packed installation-only consumer and attested local-build boundary');
} finally {
  await rm(fixture, { recursive: true, force: true });
  await rm(stateRoot, { recursive: true, force: true });
  await rm(filename, { force: true });
}

function runNpm(args, options) {
  if (!process.env.npm_execpath) throw new Error('packed test must run through npm');
  return execFileSync(process.execPath, [process.env.npm_execpath, ...args], options);
}

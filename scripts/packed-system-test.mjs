import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const required = ['DIAMOND_TGZ', 'TAPROOT_TGZ', 'WORKSHOP_TGZ'];
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('packed system test must be started through npm');
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} must point to the exact package handoff tarball`);
}
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
for (const [name, specifier] of Object.entries(packageJson.dependencies)) {
  if (/^(?:file:|link:|workspace:)/u.test(specifier)) throw new Error(`Publishable dependency ${name} uses forbidden ${specifier}`);
}

runNpm(['run', 'build']);
const pack = runNpm(['pack', '--json']);
const [{ filename }] = JSON.parse(pack.stdout);
const archiveEntries = run('tar', ['-tzf', resolve(filename)]).stdout;
if (/hono|node_modules\/@modelcontextprotocol/iu.test(archiveEntries)) throw new Error('packed artifact contains a forbidden runtime dependency path');
const fixture = await mkdtemp(join(tmpdir(), 'seedbed-packed-'));
try {
  const cache = join(fixture, 'npm-cache');
  runNpm(['init', '--yes'], fixture);
  const tarballs = [resolve(filename), ...required.map((name) => resolve(process.env[name]))];
  runNpm(['install', '--ignore-scripts', '--cache', cache, ...tarballs], fixture);
  const audit = runNpm(['audit', '--omit=dev', '--json'], fixture);
  const auditReport = JSON.parse(audit.stdout);
  if (auditReport.metadata?.vulnerabilities?.total !== 0) {
    throw new Error(`packed consumer production audit reported ${String(auditReport.metadata?.vulnerabilities?.total)} vulnerabilities`);
  }
  const consumerLock = await readFile(join(fixture, 'package-lock.json'), 'utf8');
  if (/@hono\/node-server|@modelcontextprotocol\/sdk/iu.test(consumerLock)) throw new Error('packed consumer runtime lock contains SDK or Hono');
  const runtimeFixture = join(fixture, 'offline-consumer');
  await mkdir(runtimeFixture);
  await copyFile(join(fixture, 'package.json'), join(runtimeFixture, 'package.json'));
  await copyFile(join(fixture, 'package-lock.json'), join(runtimeFixture, 'package-lock.json'));
  runNpm(['ci', '--ignore-scripts', '--offline', '--registry=http://127.0.0.1:9', '--cache', cache], runtimeFixture);
  const offlineAudit = JSON.parse(runNpm(['audit', '--omit=dev', '--json', '--offline', '--registry=http://127.0.0.1:9', '--cache', cache], runtimeFixture).stdout);
  if (offlineAudit.metadata?.vulnerabilities?.total !== 0) throw new Error('offline packed consumer production audit was not zero');
  const cli = join(runtimeFixture, 'node_modules', '@gnolith', 'seedbed', 'dist', 'cli.js');
  const help = run(process.execPath, [cli, '--help'], runtimeFixture);
  if (!help.stdout.includes('mcp --stdio') || /\bserve\b/u.test(help.stdout)) throw new Error('packed CLI surface is invalid');
  const missing = run(process.execPath, [cli, 'doctor'], runtimeFixture, false);
  if (missing.status !== 4) throw new Error(`doctor missing-database exit was ${missing.status}`);

  const databasePath = join(runtimeFixture, 'data', 'gnolith.sqlite');
  const secretPath = join(runtimeFixture, 'root.key');
  await writeFile(secretPath, Buffer.alloc(32, 0x50), { mode: 0o600 });
  const globals = [cli, '--database', databasePath, '--base-iri', 'https://packed.seedbed.test/instance/', '--root-secret-file', secretPath, '--principal', 'agent', '--workspace', 'workspace', '--log-level', 'silent'];
  const initialized = json(run(process.execPath, [...globals, 'init'], runtimeFixture).stdout);
  if (!initialized.ready) throw new Error('packed init was not ready');
  const bootstrapped = json(run(process.execPath, [...globals, 'auth', 'bootstrap'], runtimeFixture).stdout);
  if (!bootstrapped.bootstrapped) throw new Error('packed authorization bootstrap failed');
  await Promise.all([
    runAsync(process.execPath, [...globals, 'migrate'], runtimeFixture),
    runAsync(process.execPath, [...globals, 'migrate'], runtimeFixture),
  ]);
  const created = json(run(process.execPath, [...globals, 'call', 'upsert_memory', '--arguments', '{"slug":"packed-restart","description":"Packed restart","content":"Durable"}'], runtimeFixture).stdout);
  if (created.value?.slug !== 'packed-restart') throw new Error('packed memory write failed');
  const reopened = json(run(process.execPath, [...globals, 'call', 'get_memory', '--arguments', '{"slug":"packed-restart"}'], runtimeFixture).stdout);
  if (reopened.value?.slug !== 'packed-restart') throw new Error('data did not survive process restart');

  const status = json(run(process.execPath, [...globals, 'auth', 'status'], runtimeFixture).stdout);
  const manifestPath = join(runtimeFixture, 'principal-authorization.json');
  await writeFile(manifestPath, JSON.stringify({
    version: 1,
    expectedAuthorizationRevision: status.authorization.authorizationRevision,
    principal: 'reader',
    enabled: true,
    workspaces: ['workspace'],
    capabilities: ['read'],
  }));
  const applied = json(run(process.execPath, [...globals, 'auth', 'apply', '--manifest', manifestPath], runtimeFixture).stdout);
  const readerGlobals = [cli, '--database', databasePath, '--base-iri', 'https://packed.seedbed.test/instance/', '--root-secret-file', secretPath, '--principal', 'reader', '--workspace', 'workspace', '--log-level', 'silent'];
  const readerValue = json(run(process.execPath, [...readerGlobals, 'call', 'get_memory', '--arguments', '{"slug":"packed-restart"}'], runtimeFixture).stdout);
  if (readerValue.value?.slug !== 'packed-restart') throw new Error('declaratively granted packed reader could not read');
  await writeFile(manifestPath, JSON.stringify({
    version: 1,
    expectedAuthorizationRevision: applied.authorizationRevision,
    principal: 'reader',
    enabled: false,
    workspaces: [],
    capabilities: [],
  }));
  run(process.execPath, [...globals, 'auth', 'apply', '--manifest', manifestPath], runtimeFixture);
  const revokedReader = run(process.execPath, [...readerGlobals, 'call', 'get_memory', '--arguments', '{"slug":"packed-restart"}'], runtimeFixture, false);
  if (revokedReader.status !== 5) throw new Error(`revoked packed reader exited ${revokedReader.status}`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...globals, 'mcp', '--stdio'],
    cwd: runtimeFixture,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'seedbed-packed-test', version: '1.0.0' });
  await client.connect(transport);
  const listed = await client.listTools();
  if (!listed.tools.some(({ name }) => name === 'get_memory') || listed.tools.some(({ name }) => name === 'query_sparql')) throw new Error('MCP tool discovery surface is invalid');
  const called = await client.callTool({ name: 'get_memory', arguments: { slug: 'packed-restart' } });
  if (called.isError || called.structuredContent?.slug !== 'packed-restart') throw new Error('MCP get_memory failed after restart');
  await client.close();
} finally {
  await rm(fixture, { recursive: true, force: true });
  await rm(resolve(filename), { force: true });
}

function json(value) {
  return JSON.parse(value.trim());
}

function runNpm(args, cwd = process.cwd()) {
  return run(process.execPath, [npmCli, ...args], cwd);
}

function run(command, args, cwd = process.cwd(), expectSuccess = true) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (expectSuccess && result.status !== 0) {
    throw new Error(`${basename(command)} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function runAsync(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${basename(command)} ${args.join(' ')} failed (${code})\n${stdout}\n${stderr}`)));
  });
}

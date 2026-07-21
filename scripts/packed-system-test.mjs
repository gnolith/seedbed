import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
const fixture = await mkdtemp(join(tmpdir(), 'seedbed-packed-'));
try {
  runNpm(['init', '--yes'], fixture);
  const tarballs = [resolve(filename), ...required.map((name) => resolve(process.env[name]))];
  runNpm(['install', '--ignore-scripts', ...tarballs], fixture);
  const cli = join(fixture, 'node_modules', '@gnolith', 'seedbed', 'dist', 'cli.js');
  const help = run(process.execPath, [cli, '--help'], fixture);
  if (!help.stdout.includes('mcp --stdio') || /\bserve\b/u.test(help.stdout)) throw new Error('packed CLI surface is invalid');
  const missing = run(process.execPath, [cli, '--local-owner', 'local-owner', 'doctor'], fixture, false);
  if (missing.status !== 4) throw new Error(`doctor missing-database exit was ${missing.status}`);

  const databasePath = join(fixture, 'data', 'gnolith.sqlite');
  const globals = [cli, '--database', databasePath, '--base-iri', 'https://packed.seedbed.test/instance/', '--local-owner', 'local-owner', '--log-level', 'silent'];
  const initialized = json(run(process.execPath, [...globals, 'init'], fixture).stdout);
  if (!initialized.ready) throw new Error('packed init was not ready');
  await Promise.all([
    runAsync(process.execPath, [...globals, 'migrate'], fixture),
    runAsync(process.execPath, [...globals, 'migrate'], fixture),
  ]);
  const created = json(run(process.execPath, [...globals, 'call', 'create_item', '--arguments', '{}'], fixture).stdout);
  if (created.value?.entityId !== 'Q1') throw new Error('packed create_item did not create Q1');
  const reopened = json(run(process.execPath, [...globals, 'call', 'get_entity', '--arguments', '{"entityId":"Q1"}'], fixture).stdout);
  if (reopened.value?.entity?.id !== 'Q1') throw new Error('data did not survive process restart');
  const sparql = json(run(process.execPath, [...globals, 'sparql', 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1'], fixture).stdout);
  if (sparql.value?.type !== 'bindings' || sparql.value.data?.length !== 1) throw new Error('packed SPARQL query failed');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...globals, 'mcp', '--stdio'],
    cwd: fixture,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'seedbed-packed-test', version: '1.0.0' });
  await client.connect(transport);
  const listed = await client.listTools();
  if (!listed.tools.some(({ name }) => name === 'get_entity')) throw new Error('MCP tool discovery omitted get_entity');
  const called = await client.callTool({ name: 'get_entity', arguments: { entityId: 'Q1' } });
  if (called.isError || called.structuredContent?.entity?.id !== 'Q1') throw new Error('MCP get_entity failed after restart');
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

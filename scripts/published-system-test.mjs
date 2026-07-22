import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const version = process.env.SEEDBED_VERSION;
if (!version || !/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('SEEDBED_VERSION must be an exact semver');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('published system test must run through npm');
const fixture = await mkdtemp(join(tmpdir(), 'seedbed-published-'));

try {
  npm(['init', '--yes']);
  npm(['install', '--ignore-scripts', `@gnolith/seedbed@${version}`]);
  const cli = join(fixture, 'node_modules', '@gnolith', 'seedbed', 'dist', 'cli.js');
  const database = join(fixture, 'data', 'gnolith.sqlite');
  const blobs = join(fixture, 'data', 'blobs');
  const secret = join(fixture, 'root.key');
  await writeFile(secret, Buffer.alloc(32, 0x51), { mode: 0o600 });
  const globals = [cli, '--database', database, '--blobs', blobs, '--base-iri', 'https://published.seedbed.test/instance/', '--root-secret-file', secret, '--principal', 'agent', '--workspace', 'workspace', '--log-level', 'silent'];
  expectJson(run(process.execPath, [...globals, 'init']).stdout, (value) => value.ready === true, 'published init');
  expectJson(run(process.execPath, [...globals, 'auth', 'bootstrap']).stdout, (value) => value.bootstrapped === true, 'published authorization bootstrap');
  expectJson(run(process.execPath, [...globals, 'call', 'upsert_memory', '--arguments', '{"slug":"published-restart","description":"Published restart","content":"Durable"}']).stdout, (value) => value.value?.slug === 'published-restart', 'published memory write');
  expectJson(run(process.execPath, [...globals, 'call', 'get_memory', '--arguments', '{"slug":"published-restart"}']).stdout, (value) => value.value?.slug === 'published-restart', 'published restart read');
  const snapshot = join(fixture, 'published.seedbed-snapshot.gz');
  expectJson(run(process.execPath, [...globals, 'snapshot', 'create', '--output', snapshot]).stdout, (value) => value.valid === true && value.manifest?.secretsExported === false, 'published snapshot create');
  expectJson(run(process.execPath, [...globals, 'snapshot', 'verify', '--input', snapshot]).stdout, (value) => value.valid === true, 'published snapshot verify');
  const restoreGlobals = [cli, '--database', join(fixture, 'restore', 'gnolith.sqlite'), '--blobs', join(fixture, 'restore', 'blobs'), '--base-iri', 'https://published.seedbed.test/instance/', '--root-secret-file', secret, '--principal', 'agent', '--workspace', 'workspace', '--log-level', 'silent'];
  expectJson(run(process.execPath, [...restoreGlobals, 'snapshot', 'restore', '--input', snapshot]).stdout, (value) => value.valid === true, 'published snapshot restore');
  expectJson(run(process.execPath, [...restoreGlobals, 'call', 'get_memory', '--arguments', '{"slug":"published-restart"}']).stdout, (value) => value.value?.slug === 'published-restart', 'published restored read');

  const transport = new StdioClientTransport({ command: process.execPath, args: [...globals, 'mcp', '--stdio'], cwd: fixture, stderr: 'pipe' });
  const client = new Client({ name: 'seedbed-published-test', version: '1.0.0' });
  await client.connect(transport);
  const tools = await client.listTools();
  if (!tools.tools.some(({ name }) => name === 'get_memory') || tools.tools.some(({ name }) => name === 'query_sparql')) throw new Error('published MCP discovery failed');
  const entity = await client.callTool({ name: 'get_memory', arguments: { slug: 'published-restart' } });
  if (entity.isError || entity.structuredContent?.slug !== 'published-restart') throw new Error('published MCP restart read failed');
  await client.close();
} finally {
  await rm(fixture, { recursive: true, force: true });
}

function npm(args) {
  return run(process.execPath, [npmCli, ...args]);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: fixture, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  return result;
}

function expectJson(text, predicate, label) {
  const value = JSON.parse(text.trim());
  if (!predicate(value)) throw new Error(`${label} returned ${text}`);
}


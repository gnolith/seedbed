import { mkdtemp, rm } from 'node:fs/promises';
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
  const globals = [cli, '--database', database, '--base-iri', 'https://published.seedbed.test/instance/', '--local-owner', 'local-owner', '--log-level', 'silent'];
  expectJson(run(process.execPath, [...globals, 'init']).stdout, (value) => value.ready === true, 'published init');
  expectJson(run(process.execPath, [...globals, 'call', 'create_item', '--arguments', '{}']).stdout, (value) => value.value?.entityId === 'Q1', 'published create_item');
  expectJson(run(process.execPath, [...globals, 'call', 'get_entity', '--arguments', '{"entityId":"Q1"}']).stdout, (value) => value.value?.entity?.id === 'Q1', 'published restart read');
  expectJson(run(process.execPath, [...globals, 'sparql', 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1']).stdout, (value) => value.value?.type === 'bindings', 'published SPARQL');

  const transport = new StdioClientTransport({ command: process.execPath, args: [...globals, 'mcp', '--stdio'], cwd: fixture, stderr: 'pipe' });
  const client = new Client({ name: 'seedbed-published-test', version: '1.0.0' });
  await client.connect(transport);
  const tools = await client.listTools();
  if (!tools.tools.some(({ name }) => name === 'get_entity')) throw new Error('published MCP discovery failed');
  const entity = await client.callTool({ name: 'get_entity', arguments: { entityId: 'Q1' } });
  if (entity.isError || entity.structuredContent?.entity?.id !== 'Q1') throw new Error('published MCP restart read failed');
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


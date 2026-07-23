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
  expectJson(run(process.execPath, [...globals, 'call', 'memory_history', '--arguments', '{"slug":"published-restart","limit":10}']).stdout, (value) => value.value?.[0]?.revision === 1, 'published Memory history');
  const task = JSON.parse(run(process.execPath, [...globals, 'call', 'create_task', '--arguments', '{"description":"Published task","prompt":"Verify published history","memorySlugs":["published-restart"]}']).stdout).value;
  expectJson(run(process.execPath, [...globals, 'call', 'task_history', '--arguments', JSON.stringify({ id: task.id, limit: 10 })]).stdout, (value) => value.value?.[0]?.revision === 1, 'published Task history');
  expectJson(run(process.execPath, [...globals, 'call', 'create_prompt', '--arguments', '{"id":"published-prompt","name":"published-prompt","title":"Published prompt","promptText":"Verify the public assembly"}']).stdout, (value) => value.value?.id === 'published-prompt', 'published Prompt create');
  expectJson(run(process.execPath, [...globals, 'call', 'prompt_history', '--arguments', '{"id":"published-prompt"}']).stdout, (value) => value.value?.[0]?.revision === 1, 'published Prompt history');
  expectJson(run(process.execPath, [...globals, 'call', 'create_property', '--arguments', '{"id":"P1","datatype":"string","labels":{"en":{"language":"en","value":"Published property"}}}']).stdout, (value) => value.value?.entityId === 'P1', 'published Property create');
  const statement = { id: 'Q1$published', type: 'statement', text: 'Published statement-only chrysoberyl provenance', rank: 'normal', mainsnak: { snaktype: 'value', property: 'P1', datatype: 'string', datavalue: { type: 'string', value: 'published-value' } }, qualifiers: {}, 'qualifiers-order': [], references: [] };
  expectJson(run(process.execPath, [...globals, 'call', 'create_item', '--arguments', JSON.stringify({ id: 'Q1', labels: { en: { language: 'en', value: 'Published item' } }, claims: { P1: [statement] }, statementRestrictions: { [statement.id]: [] } })]).stdout, (value) => value.value?.entityId === 'Q1', 'published Item create');
  expectJson(run(process.execPath, [...globals, 'call', 'set_description', '--arguments', '{"entityId":"Q1","language":"en","value":"Published revised item","expectedRevision":1}']).stdout, (value) => value.value?.newRevision === 2, 'published Item policy-preserving edit');
  expectJson(run(process.execPath, [...globals, 'call', 'item_history', '--arguments', '{"entityId":"Q1","limit":2}']).stdout, (value) => value.value?.items?.length === 2, 'published Item history');
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
  for (const name of ['get_memory', 'task_history', 'memory_history', 'prompt_history', 'item_history', 'statement_revision', 'resource_history', 'annotation_history', 'validate_sparql', 'dry_run_sparql', 'query_sparql']) {
    if (!tools.tools.some((tool) => tool.name === name)) throw new Error(`published MCP discovery omitted ${name}`);
  }
  const entity = await client.callTool({ name: 'get_memory', arguments: { slug: 'published-restart' } });
  if (entity.isError || entity.structuredContent?.slug !== 'published-restart') throw new Error('published MCP restart read failed');
  const itemHistory = await client.callTool({ name: 'item_history', arguments: { entityId: 'Q1', limit: 2 } });
  if (itemHistory.isError || itemHistory.structuredContent?.items?.length !== 2) throw new Error('published MCP Item history failed');
  const validation = await client.callTool({ name: 'validate_sparql', arguments: { query: 'ASK {}' } });
  if (validation.isError || validation.structuredContent?.valid !== true) throw new Error('published MCP SPARQL validation failed');
  const dryRun = await client.callTool({ name: 'dry_run_sparql', arguments: { query: 'ASK {}' } });
  if (dryRun.isError || dryRun.structuredContent?.dryRun !== true) throw new Error('published MCP SPARQL dry-run failed');
  const query = await client.callTool({ name: 'query_sparql', arguments: { query: 'ASK {}' } });
  if (query.isError || typeof query.structuredContent?.body !== 'string') throw new Error('published MCP SPARQL query failed');
  const update = await client.callTool({ name: 'query_sparql', arguments: { query: 'INSERT DATA { <urn:s> <urn:p> <urn:o> }' } });
  if (!update.isError) throw new Error('published MCP SPARQL update was not rejected');
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


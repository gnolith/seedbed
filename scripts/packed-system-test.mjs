import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
  const blobPath = join(runtimeFixture, 'data', 'blobs');
  const secretPath = join(runtimeFixture, 'root.key');
  await writeFile(secretPath, Buffer.alloc(32, 0x50), { mode: 0o600 });
  const globals = [cli, '--database', databasePath, '--blobs', blobPath, '--base-iri', 'https://packed.seedbed.test/instance/', '--root-secret-file', secretPath, '--principal', 'agent', '--workspace', 'workspace', '--log-level', 'silent'];
  const initialized = json(run(process.execPath, [...globals, 'init'], runtimeFixture).stdout);
  if (!initialized.ready) throw new Error('packed init was not ready');
  const bootstrapped = json(run(process.execPath, [...globals, 'auth', 'bootstrap'], runtimeFixture).stdout);
  if (!bootstrapped.bootstrapped) throw new Error('packed authorization bootstrap failed');
  await Promise.all([
    runAsync(process.execPath, [...globals, 'migrate'], runtimeFixture),
    runAsync(process.execPath, [...globals, 'migrate'], runtimeFixture),
  ]);
  const call = (name, argumentsValue = {}, selectedGlobals = globals) => json(run(
    process.execPath,
    [...selectedGlobals, 'call', name, '--arguments', JSON.stringify(argumentsValue)],
    runtimeFixture,
  ).stdout).value;
  const statement = {
    id: 'Q1$packed-corpus', type: 'statement', text: 'Packed corpus statement records igneous petrology provenance', rank: 'normal',
    mainsnak: { snaktype: 'value', property: 'P1', datatype: 'string', datavalue: { type: 'string', value: 'packed corpus igneous' } },
    qualifiers: {}, 'qualifiers-order': [], references: [],
  };
  if (call('create_property', { id: 'P1', datatype: 'string', labels: { en: { language: 'en', value: 'Packed corpus property' } } }).entityId !== 'P1') throw new Error('packed property write failed');
  if (call('create_item', {
    id: 'Q1', labels: { en: { language: 'en', value: 'Packed corpus item' } }, descriptions: { en: { language: 'en', value: 'Packed artifact entity' } },
    claims: { P1: [statement] }, statementRestrictions: { [statement.id]: [] },
  }).entityId !== 'Q1') throw new Error('packed item and statement write failed');
  if (call('set_description', { entityId: 'Q1', language: 'en', value: 'Packed artifact entity revised', expectedRevision: 1 }).newRevision !== 2) {
    throw new Error('packed ordinary Item edit did not preserve statement authorization');
  }
  const itemHistory = call('item_history', { entityId: 'Q1', limit: 2 });
  if (itemHistory.items.length !== 2 || itemHistory.items[0].revision !== 2 || itemHistory.items[1].revision !== 1) throw new Error('packed Item history failed');
  if (call('statement_revision', { entityId: 'Q1', statementId: statement.id, revision: 2 }).statement?.id !== statement.id) throw new Error('packed Statement revision failed');
  const resourceText = 'Packed corpus resource describes a basalt specimen';
  const resourceBytes = Buffer.from(resourceText);
  if (call('content_resource_create', { resource: {
    id: 'packed-resource', itemId: 'Q1', title: 'Packed corpus resource', payload: { kind: 'inline-text', text: resourceText },
    mediaType: 'text/plain', language: 'en', integrity: { algorithm: 'sha256', digest: createHash('sha256').update(resourceBytes).digest('hex'), byteLength: resourceBytes.byteLength },
  } }).id !== 'packed-resource') throw new Error('packed resource write failed');
  if (call('resource_history', { id: 'packed-resource', limit: 10 }).items?.[0]?.revision !== 1) throw new Error('packed Resource history failed');
  if (call('content_annotation_create', { annotation: {
    id: 'packed-annotation', body: { kind: 'text', text: 'Packed corpus annotation identifies olivine' },
    target: { kind: 'resource', sourceId: 'packed-resource' }, targetVisibility: { version: 1, clauses: [] },
  } }).id !== 'packed-annotation') throw new Error('packed annotation write failed');
  if (call('annotation_history', { id: 'packed-annotation', limit: 10 }).items?.[0]?.revision !== 1) throw new Error('packed Annotation history failed');
  const created = json(run(process.execPath, [...globals, 'call', 'upsert_memory', '--arguments', '{"slug":"packed-restart","description":"Packed corpus restart","content":"Durable packed corpus guidance"}'], runtimeFixture).stdout);
  if (created.value?.slug !== 'packed-restart') throw new Error('packed memory write failed');
  await Promise.all(Array.from({ length: 8 }, (_, index) => runAsync(process.execPath, [
    ...globals, 'call', 'upsert_memory', '--arguments', JSON.stringify({
      slug: `packed-concurrent-${index}`, description: `Packed concurrent ${index}`, content: `Durable packed concurrent guidance ${index}`,
    }),
  ], runtimeFixture)));
  const packedTask = call('create_task', { description: 'Packed corpus task', prompt: 'Execute the packed corpus workflow', memorySlugs: ['packed-restart'] });
  call('create_prompt', { id: 'packed-prompt-a', name: 'packed-prompt-a', title: 'Packed corpus prompt A', promptText: 'Follow packed corpus procedure A' });
  call('create_prompt', { id: 'packed-prompt-b', name: 'packed-prompt-b', title: 'Packed corpus prompt B', promptText: 'Follow packed corpus procedure B' });
  call('create_prompt', { id: 'packed-prompt-c', name: 'packed-prompt-c', title: 'Packed corpus prompt C', promptText: 'Follow packed corpus procedure C' });
  if (call('task_history', { id: packedTask.id, limit: 10 })[0]?.revision !== 1) throw new Error('packed Task history failed');
  if (call('memory_history', { slug: 'packed-restart', limit: 10 })[0]?.revision !== 1) throw new Error('packed Memory history failed');
  if (call('prompt_history', { id: 'packed-prompt-a' })[0]?.revision !== 1) throw new Error('packed Prompt history failed');

  const promptFirst = call('list_prompts', { limit: 1 });
  if (promptFirst.items.length !== 1 || typeof promptFirst.cursor !== 'string') throw new Error('packed nonempty Prompt list did not create a durable cursor');
  const promptSecond = call('list_prompts', { limit: 1, cursor: promptFirst.cursor });
  if (promptSecond.items.length !== 1 || promptSecond.items[0].id === promptFirst.items[0].id) throw new Error('packed Prompt continuation did not advance');
  const stalePromptFirst = call('list_prompts', { limit: 1 });
  const stalePromptSecond = call('list_prompts', { limit: 1, cursor: stalePromptFirst.cursor });
  const staleTarget = stalePromptSecond.items[0];
  call('update_prompt', { id: staleTarget.id, expectedRevision: staleTarget.revision, promptText: `${staleTarget.promptText} updated` });
  const stalePrompt = run(process.execPath, [...globals, 'call', 'list_prompts', '--arguments', JSON.stringify({ limit: 1, cursor: stalePromptFirst.cursor })], runtimeFixture, false);
  if (stalePrompt.status === 0) throw new Error('packed Prompt cursor survived a canonical row revision');
  const restartedPromptList = call('list_prompts', { limit: 2 });
  if (restartedPromptList.items.length !== 2 || typeof restartedPromptList.cursor !== 'string') throw new Error('packed Prompt cursor state did not survive process restart');

  const searchSevenKinds = (selectedGlobals = globals) => {
    let page;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      page = call('search', { text: 'packed corpus', limit: 50 }, selectedGlobals);
      if (new Set(page.results.map(({ kind }) => kind)).size >= 7) break;
    }
    const expectedKinds = ['statement', 'item', 'task', 'memory', 'prompt', 'resource', 'annotation'];
    const actualKinds = new Set(page.results.map(({ kind }) => kind));
    for (const kind of expectedKinds) {
      if (!actualKinds.has(kind)) throw new Error(`packed unified search omitted ${kind}`);
      const result = page.results.find((candidate) => candidate.kind === kind);
      call('search_hydrate', { result }, selectedGlobals);
    }
    return page;
  };
  searchSevenKinds();
  if (!call('search', { text: 'provenance', kinds: ['item'], limit: 10 }).results.some(({ sourceId }) => sourceId === 'Q1')) {
    throw new Error('packed Item aggregate omitted current Statement text');
  }
  const sparql = call('query_sparql', { query: 'SELECT ?label WHERE { <https://packed.seedbed.test/instance/entity/Q1> <http://www.w3.org/2000/01/rdf-schema#label> ?label }' });
  if (!sparql.body.includes('Packed corpus item')) throw new Error('packed SPARQL query omitted canonical item label');
  if (!call('validate_sparql', { query: 'ASK {}' }).valid) throw new Error('packed SPARQL validation failed under read');
  if (!call('dry_run_sparql', { query: 'ASK {}' }).dryRun) throw new Error('packed SPARQL dry-run failed under read');
  const rejectedUpdate = run(process.execPath, [...globals, 'call', 'query_sparql', '--arguments', JSON.stringify({ query: 'INSERT DATA { <urn:s> <urn:p> <urn:o> }' })], runtimeFixture, false);
  if (rejectedUpdate.status === 0) throw new Error('packed read-only SPARQL accepted an update');
  const beforeRebuild = call('search_admin_health');
  const shadow = call('search_admin_rebuild');
  if (shadow.shadowCorpusGeneration !== beforeRebuild.activeCorpusGeneration + 1) throw new Error('packed shadow rebuild did not allocate the next generation');
  let activated = false;
  for (let attempt = 0; attempt < 30 && !activated; attempt += 1) {
    call('search_admin_run', { maxJobs: 100, maxRebuildRoots: 100 });
    const activation = run(process.execPath, [...globals, 'call', 'search_admin_activate', '--arguments', '{}'], runtimeFixture, false);
    activated = activation.status === 0;
  }
  if (!activated) throw new Error('packed shadow rebuild did not become activatable');
  const afterRebuild = call('search_admin_health');
  if (afterRebuild.activeCorpusGeneration !== shadow.shadowCorpusGeneration || afterRebuild.shadowCorpusGeneration !== null || afterRebuild.blockedProducerKinds.length !== 0) throw new Error('packed shadow activation health is invalid');
  searchSevenKinds();
  const reopened = json(run(process.execPath, [...globals, 'call', 'get_memory', '--arguments', '{"slug":"packed-restart"}'], runtimeFixture).stdout);
  if (reopened.value?.slug !== 'packed-restart') throw new Error('data did not survive process restart');

  const snapshotPath = join(runtimeFixture, 'installation.seedbed-snapshot.gz');
  const snapshot = json(run(process.execPath, [...globals, 'snapshot', 'create', '--output', snapshotPath], runtimeFixture).stdout);
  if (!snapshot.valid || snapshot.manifest?.secretsExported !== false) throw new Error('packed snapshot creation failed');
  const verifiedSnapshot = json(run(process.execPath, [...globals, 'snapshot', 'verify', '--input', snapshotPath], runtimeFixture).stdout);
  if (!verifiedSnapshot.valid || verifiedSnapshot.manifest?.installationId !== snapshot.manifest?.installationId) throw new Error('packed snapshot verification failed');
  const restoredDatabasePath = join(runtimeFixture, 'restored', 'gnolith.sqlite');
  const restoredBlobPath = join(runtimeFixture, 'restored', 'blobs');
  const restoredGlobals = [cli, '--database', restoredDatabasePath, '--blobs', restoredBlobPath, '--base-iri', 'https://packed.seedbed.test/instance/', '--root-secret-file', secretPath, '--principal', 'agent', '--workspace', 'workspace', '--log-level', 'silent'];
  const restoredSnapshot = json(run(process.execPath, [...restoredGlobals, 'snapshot', 'restore', '--input', snapshotPath], runtimeFixture).stdout);
  if (restoredSnapshot.manifest?.installationId !== snapshot.manifest?.installationId) throw new Error('packed snapshot identity changed on restore');
  const restoredMemory = json(run(process.execPath, [...restoredGlobals, 'call', 'get_memory', '--arguments', '{"slug":"packed-restart"}'], runtimeFixture).stdout);
  if (restoredMemory.value?.slug !== 'packed-restart') throw new Error('packed snapshot did not restore canonical behavior');
  searchSevenKinds(restoredGlobals);

  const authorizationRevisionPromptPage = call('list_prompts', { limit: 1 });
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
  const authorizationRevisionPrompt = run(process.execPath, [...globals, 'call', 'list_prompts', '--arguments', JSON.stringify({ limit: 1, cursor: authorizationRevisionPromptPage.cursor })], runtimeFixture, false);
  if (authorizationRevisionPrompt.status === 0) throw new Error('packed Prompt cursor survived an authorization revision advance');
  const readerGlobals = [cli, '--database', databasePath, '--base-iri', 'https://packed.seedbed.test/instance/', '--root-secret-file', secretPath, '--principal', 'reader', '--workspace', 'workspace', '--log-level', 'silent'];
  const readerValue = json(run(process.execPath, [...readerGlobals, 'call', 'get_memory', '--arguments', '{"slug":"packed-restart"}'], runtimeFixture).stdout);
  if (readerValue.value?.slug !== 'packed-restart') throw new Error('declaratively granted packed reader could not read');
  if (!call('validate_sparql', { query: 'ASK {}' }, readerGlobals).valid || !call('dry_run_sparql', { query: 'ASK {}' }, readerGlobals).dryRun) throw new Error('packed read-only principal could not validate or dry-run SPARQL');
  if (!call('query_sparql', { query: 'ASK {}' }, readerGlobals).body) throw new Error('packed read-only principal could not query SPARQL');
  if (call('item_history', { entityId: 'Q1', limit: 2 }, readerGlobals).items?.length !== 2) throw new Error('packed read-only principal could not read Item history');
  const readerUpdate = run(process.execPath, [...readerGlobals, 'call', 'query_sparql', '--arguments', JSON.stringify({ query: 'INSERT DATA { <urn:s> <urn:p> <urn:o> }' })], runtimeFixture, false);
  if (readerUpdate.status === 0) throw new Error('packed read-only principal executed a SPARQL update');
  const readerWrite = run(process.execPath, [...readerGlobals, 'call', 'create_item', '--arguments', JSON.stringify({ id: 'Q-reader-forbidden' })], runtimeFixture, false);
  if (readerWrite.status === 0) throw new Error('packed read-only principal executed a Taproot mutation');
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
  for (const name of ['get_memory', 'list_prompts', 'task_history', 'memory_history', 'prompt_history', 'item_history', 'statement_revision', 'resource_history', 'annotation_history', 'validate_sparql', 'dry_run_sparql', 'query_sparql']) {
    if (!listed.tools.some((tool) => tool.name === name)) throw new Error(`MCP tool discovery omitted ${name}`);
  }
  for (const name of ['set_label', 'item_history', 'statement_revision', 'resource_history', 'annotation_history']) {
    const tool = listed.tools.find((candidate) => candidate.name === name);
    if (!tool || tool.inputSchema?.additionalProperties !== false || Object.keys(tool.inputSchema?.properties ?? {}).length === 0) {
      throw new Error(`MCP tool discovery returned a non-exact or empty schema for ${name}`);
    }
  }
  const called = await client.callTool({ name: 'get_memory', arguments: { slug: 'packed-restart' } });
  if (called.isError || called.structuredContent?.slug !== 'packed-restart') throw new Error('MCP get_memory failed after restart');
  const mcpHistory = await client.callTool({ name: 'item_history', arguments: { entityId: 'Q1', limit: 2 } });
  if (mcpHistory.isError || mcpHistory.structuredContent?.items?.length !== 2) throw new Error('MCP Item history failed after restart');
  const mcpTaskHistory = await client.callTool({ name: 'task_history', arguments: { id: packedTask.id, limit: 10 } });
  if (mcpTaskHistory.isError || mcpTaskHistory.structuredContent?.value?.[0]?.revision !== 1) throw new Error('MCP Task history failed after restart');
  const mcpMemoryHistory = await client.callTool({ name: 'memory_history', arguments: { slug: 'packed-restart', limit: 10 } });
  if (mcpMemoryHistory.isError || mcpMemoryHistory.structuredContent?.value?.[0]?.revision !== 1) throw new Error('MCP Memory history failed after restart');
  const mcpPromptHistory = await client.callTool({ name: 'prompt_history', arguments: { id: 'packed-prompt-a' } });
  if (mcpPromptHistory.isError || mcpPromptHistory.structuredContent?.value?.[0]?.revision !== 1) throw new Error('MCP Prompt history failed after restart');
  const mcpPromptFirst = await client.callTool({ name: 'list_prompts', arguments: { limit: 1 } });
  const mcpPromptFirstValue = mcpPromptFirst.structuredContent;
  if (mcpPromptFirst.isError || mcpPromptFirstValue?.items?.length !== 1 || typeof mcpPromptFirstValue.cursor !== 'string') throw new Error('MCP nonempty Prompt list did not return a cursor');
  const mcpPromptSecond = await client.callTool({ name: 'list_prompts', arguments: { limit: 1, cursor: mcpPromptFirstValue.cursor } });
  if (mcpPromptSecond.isError || mcpPromptSecond.structuredContent?.items?.length !== 1 || mcpPromptSecond.structuredContent.items[0].id === mcpPromptFirstValue.items[0].id) throw new Error('MCP Prompt continuation did not advance');
  const mcpStaleFirst = await client.callTool({ name: 'list_prompts', arguments: { limit: 1 } });
  const mcpStaleSecond = await client.callTool({ name: 'list_prompts', arguments: { limit: 1, cursor: mcpStaleFirst.structuredContent?.cursor } });
  const mcpStaleTarget = mcpStaleSecond.structuredContent?.items?.[0];
  if (!mcpStaleTarget) throw new Error('MCP Prompt stale-cursor fixture was missing');
  const mcpPromptUpdate = await client.callTool({ name: 'update_prompt', arguments: { id: mcpStaleTarget.id, expectedRevision: mcpStaleTarget.revision, promptText: `${mcpStaleTarget.promptText} via MCP` } });
  if (mcpPromptUpdate.isError) throw new Error('MCP Prompt stale-cursor mutation failed');
  const mcpStaleResult = await client.callTool({ name: 'list_prompts', arguments: { limit: 1, cursor: mcpStaleFirst.structuredContent?.cursor } });
  if (!mcpStaleResult.isError) throw new Error('MCP Prompt cursor survived a canonical row revision');
  const mcpRevisionFirst = await client.callTool({ name: 'list_prompts', arguments: { limit: 1 } });
  const revisionStatus = json(run(process.execPath, [...globals, 'auth', 'status'], runtimeFixture).stdout);
  await writeFile(manifestPath, JSON.stringify({
    version: 1,
    expectedAuthorizationRevision: revisionStatus.authorization.authorizationRevision,
    principal: 'cursor-revision-bump',
    enabled: true,
    workspaces: ['workspace'],
    capabilities: ['read'],
  }));
  run(process.execPath, [...globals, 'auth', 'apply', '--manifest', manifestPath], runtimeFixture);
  const mcpRevisionResult = await client.callTool({ name: 'list_prompts', arguments: { limit: 1, cursor: mcpRevisionFirst.structuredContent?.cursor } });
  if (!mcpRevisionResult.isError) throw new Error('MCP Prompt cursor survived an authorization revision advance');
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

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const image = process.env.SEEDBED_TEST_IMAGE ?? 'seedbed:test';
const volume = `seedbed-test-${randomUUID()}`;
const restoreVolume = `seedbed-restore-${randomUUID()}`;
const secretVolume = `seedbed-secret-${randomUUID()}`;
const wrongSecretVolume = `seedbed-wrong-secret-${randomUUID()}`;
const container = `seedbed-signal-${randomUUID()}`;
const fixture = await mkdtemp(join(tmpdir(), 'seedbed-docker-secret-'));
const secret = join(fixture, 'root.key');
const wrongSecret = join(fixture, 'wrong.key');
const semanticConfig = join(fixture, 'semantic.json');
await writeFile(secret, Buffer.alloc(32, 0x44), { mode: 0o600 });
await writeFile(wrongSecret, Buffer.alloc(32, 0x45), { mode: 0o600 });
const provider = spawn(process.execPath, [fileURLToPath(new URL('deterministic-embedding-provider.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'inherit'] });
const providerPort = await new Promise((resolve, reject) => {
  provider.once('error', reject);
  provider.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
});
if (!Number.isSafeInteger(providerPort) || providerPort < 1) throw new Error('Docker semantic fixture returned an invalid port');
await writeFile(semanticConfig, JSON.stringify({ semanticConfigurations: [{
  id: 'docker-sqlite', name: 'Docker deterministic SQLite', selected: true,
  provider: { kind: 'openai-compatible', endpoint: `http://host.docker.internal:${providerPort}/v1`, model: 'fixture', dimensions: 2, allowPrivateEndpoint: true },
  vectorIndex: { kind: 'sqlite' },
}] }));
const baseEnvironment = ['-e', 'SEEDBED_BASE_IRI=https://docker.seedbed.test/instance/', '-e', 'SEEDBED_ROOT_SECRET_FILE=/run/secrets/seedbed-root', '-e', 'SEEDBED_PRINCIPAL_SELECTOR=agent', '-e', 'SEEDBED_WORKSPACE_SELECTOR=workspace', '-e', 'SEEDBED_LOG_LEVEL=silent'];
const secretMount = ['-v', `${secretVolume}:/run/secrets:ro`];
let client;

try {
  const installed = JSON.parse(docker(['run', '--rm', '--entrypoint', 'node', image, '-e', `
    const fs = require('fs');
    const versions = {};
    for (const name of ['diamond', 'taproot', 'workshop', 'seedbed']) {
      versions[name] = JSON.parse(fs.readFileSync('/opt/seedbed/node_modules/@gnolith/' + name + '/package.json')).version;
    }
    process.stdout.write(JSON.stringify(versions));
  `]).stdout);
  const expectedVersions = { diamond: '0.4.1', taproot: '0.4.2', workshop: '0.4.2', seedbed: '0.3.2' };
  if (JSON.stringify(installed) !== JSON.stringify(expectedVersions)) {
    throw new Error(`image package tuple is ${JSON.stringify(installed)}; expected ${JSON.stringify(expectedVersions)}`);
  }
  if (process.env.SEEDBED_CLOSURE_SHA256) {
    const expectedClosure = process.env.SEEDBED_CLOSURE_SHA256;
    const label = docker(['image', 'inspect', image, '--format', '{{index .Config.Labels "org.gnolith.production-closure.sha256"}}']).stdout.trim();
    if (label !== expectedClosure) throw new Error(`image closure label ${label} does not match ${expectedClosure}`);
    const archive = docker(['run', '--rm', '--entrypoint', 'sha256sum', image,
      '/opt/seedbed/production-closure.tar.gz',
    ]).stdout.trim().split(/\s+/u)[0];
    if (archive !== expectedClosure) throw new Error(`image closure archive ${archive} does not match ${expectedClosure}`);
    docker(['run', '--rm', '--entrypoint', 'sh', image, '-c',
      'cd /opt/seedbed && node verify-production-tree.mjs --verify .',
    ]);
  }
  docker(['volume', 'create', volume]);
  docker(['volume', 'create', restoreVolume]);
  docker(['volume', 'create', secretVolume]);
  docker(['volume', 'create', wrongSecretVolume]);
  const uid = docker(['run', '--rm', '--entrypoint', 'id', image, '-u']).stdout.trim();
  const gid = docker(['run', '--rm', '--entrypoint', 'id', image, '-g']).stdout.trim();
  if (uid === '0') throw new Error('image runs as root');
  stageSecret(secretVolume, secret, uid, gid);
  stageSecret(wrongSecretVolume, wrongSecret, uid, gid);
  const exposed = docker(['image', 'inspect', image, '--format', '{{json .Config.ExposedPorts}}']).stdout.trim();
  if (exposed !== 'null') throw new Error(`image exposes ports: ${exposed}`);
  const mount = ['-v', `${volume}:/var/lib/seedbed`];
  docker(['run', '--rm', ...mount, ...secretMount, ...baseEnvironment, image, 'init']);
  docker(['run', '--rm', ...mount, ...secretMount, ...baseEnvironment, image, 'auth', 'bootstrap']);
  const call = (name, argumentsValue = {}, selectedMount = mount) => JSON.parse(docker([
    'run', '--rm', ...selectedMount, ...secretMount, ...baseEnvironment, image, 'call', name, '--arguments', JSON.stringify(argumentsValue),
  ]).stdout).value;
  const statement = {
    id: 'Q1$docker-corpus', type: 'statement', text: 'Docker corpus statement records igneous petrology provenance', rank: 'normal',
    mainsnak: { snaktype: 'value', property: 'P1', datatype: 'string', datavalue: { type: 'string', value: 'docker corpus igneous' } },
    qualifiers: {}, 'qualifiers-order': [], references: [],
  };
  if (call('create_property', { id: 'P1', datatype: 'string', labels: { en: { language: 'en', value: 'Docker corpus property' } } }).entityId !== 'P1') throw new Error('Docker property write failed');
  if (call('create_item', {
    id: 'Q1', labels: { en: { language: 'en', value: 'Docker corpus item' } }, descriptions: { en: { language: 'en', value: 'Docker image entity' } },
    claims: { P1: [statement] }, statementRestrictions: { [statement.id]: [] },
  }).entityId !== 'Q1') throw new Error('Docker item and statement write failed');
  if (call('set_description', { entityId: 'Q1', language: 'en', value: 'Docker image entity revised', expectedRevision: 1 }).newRevision !== 2) {
    throw new Error('Docker ordinary Item edit did not preserve statement authorization');
  }
  if (call('item_history', { entityId: 'Q1', limit: 2 }).items?.length !== 2) throw new Error('Docker Item history failed');
  if (call('statement_history', { entityId: 'Q1', statementId: statement.id, limit: 2 }).items?.length !== 2) throw new Error('Docker Statement history failed');
  const resourceText = 'Docker corpus resource describes a basalt specimen';
  const resourceBytes = Buffer.from(resourceText);
  call('content_resource_create', { resource: {
    id: 'docker-resource', itemId: 'Q1', title: 'Docker corpus resource', payload: { kind: 'inline-text', text: resourceText },
    mediaType: 'text/plain', language: 'en', integrity: { algorithm: 'sha256', digest: createHash('sha256').update(resourceBytes).digest('hex'), byteLength: resourceBytes.byteLength },
  } });
  if (call('resource_revision', { id: 'docker-resource', revision: 1 }).id !== 'docker-resource') throw new Error('Docker Resource revision failed');
  call('content_annotation_create', { annotation: {
    id: 'docker-annotation', body: { kind: 'text', text: 'Docker corpus annotation identifies olivine' },
    target: { kind: 'resource', sourceId: 'docker-resource' }, targetVisibility: { version: 1, clauses: [] },
  } });
  if (call('annotation_history', { id: 'docker-annotation', limit: 10 }).items?.[0]?.revision !== 1) throw new Error('Docker Annotation history failed');
  call('upsert_memory', { slug: 'docker-restart', description: 'Docker corpus restart', content: 'Durable Docker corpus guidance' });
  const dockerTask = call('create_task', { description: 'Docker corpus task', prompt: 'Execute the Docker corpus workflow', memorySlugs: ['docker-restart'] });
  call('create_prompt', { id: 'docker-prompt', name: 'docker-prompt', title: 'Docker corpus prompt', promptText: 'Follow Docker corpus procedure' });
  if (call('task_history', { id: dockerTask.id, limit: 10 })[0]?.revision !== 1) throw new Error('Docker Task history failed');
  if (call('memory_history', { slug: 'docker-restart', limit: 10 })[0]?.revision !== 1) throw new Error('Docker Memory history failed');
  if (call('prompt_history', { id: 'docker-prompt' })[0]?.revision !== 1) throw new Error('Docker Prompt history failed');
  const assertSevenKinds = (selectedMount = mount) => {
    let page;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      page = call('search', { text: 'docker corpus', limit: 50 }, selectedMount);
      if (new Set(page.results.map(({ kind }) => kind)).size >= 7) break;
    }
    for (const kind of ['statement', 'item', 'task', 'memory', 'prompt', 'resource', 'annotation']) {
      const result = page.results.find((candidate) => candidate.kind === kind);
      if (!result) throw new Error(`Docker unified search omitted ${kind}`);
      call('search_hydrate', { result }, selectedMount);
    }
    const scoped = call('search', { text: 'docker corpus', kinds: ['resource', 'annotation'], limit: 10 }, selectedMount);
    if (scoped.results.some(({ kind }) => kind !== 'resource' && kind !== 'annotation')) throw new Error('Docker scoped search escaped requested kinds');
  };
  assertSevenKinds();
  if (!call('search', { text: 'provenance', kinds: ['item'], limit: 10 }).results.some(({ sourceId }) => sourceId === 'Q1')) {
    throw new Error('Docker Item aggregate omitted current Statement text');
  }
  const semanticMount = ['-v', `${semanticConfig}:/run/seedbed-config.json:ro`];
  const semanticCall = (name, argumentsValue = {}, selectedMount = mount) => JSON.parse(docker([
    'run', '--rm', '--add-host', 'host.docker.internal:host-gateway', ...selectedMount, ...secretMount, ...semanticMount, ...baseEnvironment, image,
    '--config', '/run/seedbed-config.json', 'call', name, '--arguments', JSON.stringify(argumentsValue),
  ]).stdout).value;
  const estimated = semanticCall('semantic_estimate', { configurationId: 'docker-sqlite', policy: { mode: 'asap', maxBatchesPerRun: 1 } });
  semanticCall('semantic_approve', { planId: estimated.planId });
  let semanticReady = false;
  for (let attempt = 0; attempt < 30 && !semanticReady; attempt += 1) {
    const status = semanticCall('semantic_status');
    semanticReady = status.selectedReady && status.plans.some((plan) => plan.planId === estimated.planId && plan.state === 'complete');
  }
  if (!semanticReady) throw new Error('Docker SQLite semantic executor did not complete across one-shot restarts');
  const semanticOnly = semanticCall('search', { text: 'semantic-concept-without-lexical-overlap', kinds: ['resource'], limit: 5 });
  if (!semanticOnly.results.some(({ sourceId }) => sourceId === 'docker-resource')) throw new Error('Docker semantic-only search did not return the resource');
  const sparql = call('query_sparql', { query: 'SELECT ?label WHERE { <https://docker.seedbed.test/instance/entity/Q1> <http://www.w3.org/2000/01/rdf-schema#label> ?label }' });
  if (!sparql.body.includes('Docker corpus item')) throw new Error('Docker SPARQL omitted the canonical item label');
  const beforeRebuild = call('search_admin_health');
  const shadow = call('search_admin_rebuild');
  if (shadow.shadowCorpusGeneration !== beforeRebuild.activeCorpusGeneration + 1) throw new Error('Docker rebuild generation is invalid');
  let activated = false;
  for (let attempt = 0; attempt < 30 && !activated; attempt += 1) {
    call('search_admin_run', { maxJobs: 100, maxRebuildRoots: 100 });
    const result = docker(['run', '--rm', ...mount, ...secretMount, ...baseEnvironment, image, 'call', 'search_admin_activate', '--arguments', '{}'], false);
    activated = result.status === 0;
  }
  if (!activated) throw new Error('Docker shadow rebuild did not become activatable');
  assertSevenKinds();
  const reopened = docker(['run', '--rm', ...mount, ...secretMount, ...baseEnvironment, image, 'call', 'get_memory', '--arguments', '{"slug":"docker-restart"}']);
  if (!reopened.stdout.includes('docker-restart')) throw new Error('replacement container did not retain authorized content');
  const snapshotPath = '/var/lib/seedbed/portable.seedbed-snapshot.gz';
  const snapshotted = docker(['run', '--rm', ...mount, ...secretMount, ...baseEnvironment, image, 'snapshot', 'create', '--output', snapshotPath]);
  if (!JSON.parse(snapshotted.stdout).valid) throw new Error('container snapshot creation failed');
  docker(['run', '--rm', ...mount, ...secretMount, ...baseEnvironment, image, 'snapshot', 'verify', '--input', snapshotPath]);
  const restoreMount = ['-v', `${restoreVolume}:/var/lib/seedbed`, '-v', `${volume}:/snapshot-source:ro`];
  const restored = docker(['run', '--rm', ...restoreMount, ...secretMount, ...baseEnvironment, image, 'snapshot', 'restore', '--input', '/snapshot-source/portable.seedbed-snapshot.gz']);
  if (!JSON.parse(restored.stdout).valid) throw new Error('container snapshot restore failed');
  const restoredMemory = docker(['run', '--rm', '-v', `${restoreVolume}:/var/lib/seedbed`, ...secretMount, ...baseEnvironment, image, 'call', 'get_memory', '--arguments', '{"slug":"docker-restart"}']);
  if (!restoredMemory.stdout.includes('docker-restart')) throw new Error('restored container lost canonical content');
  assertSevenKinds(['-v', `${restoreVolume}:/var/lib/seedbed`]);
  const restoredSemantic = semanticCall('search', { text: 'restored-semantic-concept', kinds: ['resource'], limit: 5 }, ['-v', `${restoreVolume}:/var/lib/seedbed`]);
  if (!restoredSemantic.results.some(({ sourceId }) => sourceId === 'docker-resource')) throw new Error('Docker restore did not carry compatible SQLite vector state after credential reattachment');
  const wrongMount = ['-v', `${wrongSecretVolume}:/run/secrets:ro`];
  const rejected = docker(['run', '--rm', ...mount, ...wrongMount, ...baseEnvironment, image, 'call', 'get_memory', '--arguments', '{"slug":"docker-restart"}'], false);
  if (rejected.status === 0 || !rejected.stderr.includes('Root secret does not match')) throw new Error('replacement container accepted the wrong root secret');

  const transport = new StdioClientTransport({
    command: 'docker',
    args: ['run', '--name', container, '-i', ...mount, ...secretMount, ...baseEnvironment, image, 'mcp', '--stdio'],
    stderr: 'pipe',
  });
  client = new Client({ name: 'seedbed-docker-signal-test', version: '1.0.0' });
  await client.connect(transport);
  const socketTables = docker(['exec', container, 'cat', '/proc/net/tcp', '/proc/net/tcp6']).stdout;
  const listeners = socketTables.split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter((fields) => fields.length > 3 && fields[3] === '0A');
  if (listeners.length !== 0) throw new Error(`headless MCP container opened ${listeners.length} listening TCP socket(s)`);
  let settled = 0;
  const inFlight = Array.from({ length: 10 }, (_, index) => client.callTool({ name: 'upsert_memory', arguments: { slug: `signal-${index}`, description: 'Signal test', content: 'Durable' } }).finally(() => { settled += 1; }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  if (settled === inFlight.length) throw new Error('signal test did not catch an operation in flight');
  docker(['stop', '--time', '10', container]);
  const drained = await Promise.allSettled(inFlight);
  if (drained.some(({ status }) => status === 'rejected')) throw new Error('SIGTERM rejected an in-flight operation');
  const exitCode = docker(['inspect', container, '--format', '{{.State.ExitCode}}']).stdout.trim();
  if (exitCode !== '0') throw new Error(`SIGTERM shutdown exited ${exitCode}`);
  const afterSignal = docker(['run', '--rm', ...mount, ...secretMount, ...baseEnvironment, image, 'doctor']);
  if (!JSON.parse(afterSignal.stdout).ready) throw new Error('database did not reopen after in-flight SIGTERM drain');
} finally {
  await client?.close().catch(() => undefined);
  docker(['rm', '--force', container], false);
  docker(['volume', 'rm', volume], false);
  docker(['volume', 'rm', restoreVolume], false);
  docker(['volume', 'rm', secretVolume], false);
  docker(['volume', 'rm', wrongSecretVolume], false);
  await rm(fixture, { recursive: true, force: true });
  provider.kill('SIGTERM');
}

function stageSecret(targetVolume, source, uid, gid) {
  docker(['run', '--rm', '--user', '0:0', '--entrypoint', 'sh',
    '-v', `${targetVolume}:/secret`, '-v', `${source}:/input:ro`, image,
    '-c', `install -o ${uid} -g ${gid} -m 0400 /input /secret/seedbed-root`,
  ]);
}

function docker(args, required = true) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (required && result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

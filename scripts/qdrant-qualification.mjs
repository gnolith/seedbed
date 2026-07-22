import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createQdrantVectorIndexV1 } from '@gnolith/taproot';

const image = 'qdrant/qdrant:v1.18.2@sha256:da65a06bc75e42702f80c992b99c5144b0fbd675ae7a96d2991de0bf957b7071';
const name = `seedbed-qdrant-${randomUUID()}`;
try {
  docker(['run', '--detach', '--name', name, '--publish', '127.0.0.1::6333', image]);
  const mapping = docker(['port', name, '6333/tcp']).stdout.trim();
  const port = mapping.slice(mapping.lastIndexOf(':') + 1);
  if (!/^\d+$/u.test(port)) throw new Error(`invalid Qdrant port mapping ${mapping}`);
  const endpoint = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/readyz`);
      if (response.ok) { ready = true; break; }
    } catch { /* bounded startup retry */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('pinned Qdrant container did not become ready');
  const created = await fetch(`${endpoint}/collections/seedbed`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vectors: { size: 2, distance: 'Cosine' } }),
  });
  if (!created.ok) throw new Error(`Qdrant collection create returned ${created.status}`);
  const adapter = createQdrantVectorIndexV1({ endpoint, collection: 'seedbed', allowPrivateEndpoint: true });
  await adapter.validate(2, 'cosine');
  const authorization = { version: 1, clauses: [] };
  const point = (id, configurationId, generation, vector) => ({
    id, installationId: 'installation', configurationId, generation,
    kind: 'resource', sourceId: 'resource', sourceRevision: String(generation), documentId: 'document', chunkId: null,
    contentHash: String(generation).repeat(64), authorization, selector: null, vector,
  });
  await adapter.upsert([{
    id: 'derived-qdrant-proof', installationId: 'installation', configurationId: 'configuration', generation: 1,
    kind: 'resource', sourceId: 'resource', sourceRevision: '1', documentId: 'document', chunkId: null,
    contentHash: 'a'.repeat(64), authorization, selector: null, vector: [1, 0],
  }], 2, 'cosine');
  await adapter.upsert([
    point('derived-qdrant-generation-2', 'configuration', 2, [0, 1]),
    point('derived-qdrant-model-change', 'configuration-model-change', 1, [1, 0]),
  ], 2, 'cosine');
  const results = await adapter.query({
    installationId: 'installation', configurationId: 'configuration', generation: 1, kinds: ['resource'],
    vector: [1, 0], limit: 5,
    context: { installationId: 'installation', principalId: 'owner', activeWorkspaceId: null, workspaceIds: [], capabilities: ['read'], authorizationRevision: 1 },
  }, 2, 'cosine');
  if (results.length !== 1 || results[0]?.derivedId !== 'derived-qdrant-proof') throw new Error(`Qdrant round trip returned ${JSON.stringify(results)}`);
  const generationTwo = await adapter.query({
    installationId: 'installation', configurationId: 'configuration', generation: 2, kinds: ['resource'],
    vector: [0, 1], limit: 5, context: { installationId: 'installation', principalId: 'owner', activeWorkspaceId: null, workspaceIds: [], capabilities: ['read'], authorizationRevision: 1 },
  }, 2, 'cosine');
  if (generationTwo.length !== 1 || generationTwo[0]?.derivedId !== 'derived-qdrant-generation-2') throw new Error('Qdrant mixed planned generations');
  const modelChange = await adapter.query({
    installationId: 'installation', configurationId: 'configuration-model-change', generation: 1, kinds: ['resource'],
    vector: [1, 0], limit: 5, context: { installationId: 'installation', principalId: 'owner', activeWorkspaceId: null, workspaceIds: [], capabilities: ['read'], authorizationRevision: 1 },
  }, 2, 'cosine');
  if (modelChange.length !== 1 || modelChange[0]?.derivedId !== 'derived-qdrant-model-change') throw new Error('Qdrant mixed model configurations');
  await expectRejection(() => adapter.validate(3, 'cosine'), 'dimension change');
  await expectRejection(() => adapter.validate(2, 'dot'), 'metric change');
  await adapter.delete({ installationId: 'installation', configurationId: 'configuration' });
  const retainedModelChange = await adapter.query({
    installationId: 'installation', configurationId: 'configuration-model-change', generation: 1, kinds: ['resource'],
    vector: [1, 0], limit: 5, context: { installationId: 'installation', principalId: 'owner', activeWorkspaceId: null, workspaceIds: [], capabilities: ['read'], authorizationRevision: 1 },
  }, 2, 'cosine');
  if (retainedModelChange.length !== 1) throw new Error('Qdrant configuration retirement deleted an isolated model space');
  process.stdout.write(`qualified ${image}\n`);
} finally {
  docker(['rm', '--force', name], false);
}

async function expectRejection(operation, label) {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(`Qdrant accepted incompatible ${label}`);
}

function docker(args, required = true) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (required && result.status !== 0) throw new Error(`docker ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  return result;
}

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createOllamaCompatibleEmbeddingProviderV1,
  createOpenAICompatibleEmbeddingProviderV1,
  createQdrantVectorIndexV1,
  createSqliteVectorIndexV1,
  applyTaprootMigrations,
} from '@gnolith/taproot';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { migrateDiamondStore } from '@gnolith/diamond';
import { loadConfig } from '../src/config.js';
import { createCredentialReader } from '../src/secrets.js';

describe('semantic host attachments', () => {
  it('uses OpenAI and Ollama protocols with process-local secret callbacks', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      const body = JSON.parse(String(init?.body));
      const payload = String(input).endsWith('/embeddings')
        ? { data: body.input.map(() => ({ embedding: [1, 0] })), usage: { total_tokens: 7 } }
        : { embeddings: body.input.map(() => [0, 1]) };
      return new Response(JSON.stringify(payload));
    };
    const openai = createOpenAICompatibleEmbeddingProviderV1({ endpoint: 'https://embeddings.example.test/v1', model: 'open', dimensions: 2, secret: () => 'provider-canary', fetch: fakeFetch });
    const ollama = createOllamaCompatibleEmbeddingProviderV1({ endpoint: 'http://127.0.0.1:11434', model: 'local', dimensions: 2, allowPrivateEndpoint: true, fetch: fakeFetch });
    await expect(openai.embed(['alpha'])).resolves.toEqual({ vectors: [[1, 0]], usage: { tokens: 7 } });
    await expect(ollama.embed(['beta'])).resolves.toEqual({ vectors: [[0, 1]], usage: { tokens: null } });
    expect(calls[0]?.url).toBe('https://embeddings.example.test/v1/embeddings');
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer provider-canary');
    expect(calls[1]?.url).toBe('http://127.0.0.1:11434/api/embed');
  });

  it('drives the Qdrant validation/query contract without exposing its secret in payloads', async () => {
    const requests: Array<{ url: string; headers: Headers; body?: string }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, headers: new Headers(init?.headers), ...(init?.body === undefined ? {} : { body: String(init.body) }) });
      if (url.endsWith('/collections/seedbed')) return new Response(JSON.stringify({ result: { config: { params: { vectors: { size: 2, distance: 'Cosine' } } } } }));
      if (url.endsWith('/points/query')) return new Response(JSON.stringify({ result: { points: [{ id: 'point', score: 0.9, payload: { id: 'derived-1', authorization: { version: 1, clauses: [] } } }] } }));
      return new Response('{}');
    };
    const qdrant = createQdrantVectorIndexV1({ endpoint: 'http://127.0.0.1:6333', collection: 'seedbed', allowPrivateEndpoint: true, secret: () => 'qdrant-canary', fetch: fakeFetch });
    await qdrant.validate(2, 'cosine');
    const results = await qdrant.query({ installationId: 'installation', configurationId: 'config', generation: 1, kinds: ['resource'], vector: [1, 0], limit: 5, context: { installationId: 'installation', principalId: 'owner', activeWorkspaceId: null, workspaceIds: [], capabilities: ['read'], authorizationRevision: 1 } }, 2, 'cosine');
    expect(results).toEqual([{ derivedId: 'derived-1', score: 0.9 }]);
    expect(requests.every(({ headers }) => headers.get('api-key') === 'qdrant-canary')).toBe(true);
    expect(requests.map(({ body }) => body).join('')).not.toContain('qdrant-canary');
  });

  it('loads credential selectors without loading or serializing credential bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seedbed-semantic-config-'));
    await writeFile(join(directory, 'provider.key'), 'selector-canary\n', { mode: 0o600 });
    await writeFile(join(directory, 'seedbed.config.json'), JSON.stringify({
      semanticConfigurations: [{ id: 'openai', name: 'OpenAI', selected: true, provider: { kind: 'openai-compatible', endpoint: 'https://api.example.test/v1', model: 'embed', dimensions: 2, secret: { file: './provider.key' } }, vectorIndex: { kind: 'sqlite' } }],
    }));
    const config = await loadConfig({}, {}, directory);
    const attachment = config.semanticConfigurations?.[0];
    expect(JSON.stringify(config)).not.toContain('selector-canary');
    await expect(createCredentialReader(attachment?.provider.secret)!()).resolves.toBe('selector-canary');
  });

  it('persists SQLite vectors and applies visibility before returning candidates', async () => {
    const db = new NodeSqliteDatabase(':memory:');
    try {
      await migrateDiamondStore(db);
      await applyTaprootMigrations(db, { baseIri: 'https://semantic.seedbed.test/' });
      const vectors = createSqliteVectorIndexV1(db);
      await vectors.validate(2, 'cosine');
      await vectors.upsert([
        { id: 'public', installationId: 'installation', configurationId: 'config', generation: 1, kind: 'resource', sourceId: 'public', sourceRevision: '1', documentId: 'public-doc', chunkId: null, contentHash: 'a'.repeat(64), authorization: { version: 1, clauses: [] }, selector: null, vector: [1, 0] },
        { id: 'private', installationId: 'installation', configurationId: 'config', generation: 1, kind: 'resource', sourceId: 'private', sourceRevision: '1', documentId: 'private-doc', chunkId: null, contentHash: 'b'.repeat(64), authorization: { version: 1, clauses: [[{ kind: 'principal', principalId: 'someone-else' }]] }, selector: null, vector: [1, 0] },
      ], 2, 'cosine');
      const result = await vectors.query({ installationId: 'installation', configurationId: 'config', generation: 1, kinds: ['resource'], vector: [1, 0], limit: 5, context: { installationId: 'installation', principalId: 'owner', activeWorkspaceId: null, workspaceIds: [], capabilities: ['read'], authorizationRevision: 1 } }, 2, 'cosine');
      expect(result).toEqual([{ derivedId: 'public', score: 1 }]);
      await vectors.delete({ installationId: 'installation', configurationId: 'config' });
      await expect(vectors.query({ installationId: 'installation', configurationId: 'config', generation: 1, kinds: ['resource'], vector: [1, 0], limit: 5, context: { installationId: 'installation', principalId: 'owner', activeWorkspaceId: null, workspaceIds: [], capabilities: ['read'], authorizationRevision: 1 } }, 2, 'cosine')).resolves.toEqual([]);
    } finally {
      await db.close();
    }
  });
});

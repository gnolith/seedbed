import { createSparqlHandler, type D1DatabaseLike as DiamondPersistence } from '@gnolith/diamond';
import type { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { createWorkshopCore, createWorkshopToolDispatcher } from '@gnolith/workshop/core';
import type { WorkshopCapability, WorkshopPrincipal } from '@gnolith/workshop/protocol';
import type { WorkshopToolDispatcher } from '@gnolith/workshop/core';
import type { D1DatabaseLike } from '@gnolith/workshop/server';
import type { SeedbedConfig } from './config.js';
import { requireBaseIri } from './config.js';
import { ExitCode, SeedbedError } from './errors.js';
import { OperationLifecycle } from './lifecycle.js';
import { requireReady, type TaprootAssembly } from './persistence.js';

export interface SeedbedRuntime {
  readonly database: NodeSqliteDatabase;
  readonly dispatcher: WorkshopToolDispatcher;
  readonly principal: WorkshopPrincipal;
  readonly lifecycle: OperationLifecycle;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export const LOCAL_PROCESS_CAPABILITIES = [
  'read',
  'task-write',
  'knowledge-write',
  'memory-write',
] as const satisfies readonly WorkshopCapability[];

export function createLocalPrincipal(id: string): WorkshopPrincipal {
  return { id, capabilities: LOCAL_PROCESS_CAPABILITIES };
}

export async function createSeedbedRuntime(config: SeedbedConfig, taproot: TaprootAssembly): Promise<SeedbedRuntime> {
  const baseIri = requireBaseIri(config);
  const database = await requireReady(config, taproot);
  try {
    const persistence = database as unknown as D1DatabaseLike;
    const diamondPersistence = database as unknown as DiamondPersistence;
    const handler = createSparqlHandler({ db: diamondPersistence, readOnly: true });
    const executeSparql = async (query: string, options: { signal: AbortSignal; timeoutMs: number; resultLimit: number }) => {
      const request = new Request(baseIri, {
        method: 'POST',
        headers: {
          accept: 'application/sparql-results+json, application/n-quads;q=0.9',
          'content-type': 'application/sparql-query',
        },
        body: query,
        signal: options.signal,
      });
      const response = await handler(request);
      if (!response.ok) {
        throw new SeedbedError(`SPARQL query failed (${response.status}): ${await response.text()}`, ExitCode.operation, 'sparql_failed');
      }
      const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
      if (mediaType === 'application/sparql-results+json') {
        const value = await response.json() as { boolean?: boolean; results?: { bindings?: unknown[] } };
        if (typeof value.boolean === 'boolean') return { type: 'boolean' as const, data: value.boolean, truncated: false };
        const bindings = value.results?.bindings ?? [];
        return { type: 'bindings' as const, data: bindings.slice(0, options.resultLimit), count: bindings.length, truncated: bindings.length > options.resultLimit };
      }
      const body = await response.text();
      const quads = body.split(/\r?\n/u).filter(Boolean);
      return { type: 'quads' as const, data: quads.slice(0, options.resultLimit), count: quads.length, truncated: quads.length > options.resultLimit };
    };
    const core = createWorkshopCore({
      persistence,
      executeSparql,
      knowledge: taproot.createKnowledgeService(database, baseIri),
    });
    const dispatcher = createWorkshopToolDispatcher(core);
    const lifecycle = new OperationLifecycle();
    const principal = createLocalPrincipal(config.localOwnerId);
    return {
      database,
      dispatcher,
      principal,
      lifecycle,
      async drain() {
        await lifecycle.drain(config.shutdownTimeoutMs);
      },
      async close() {
        await lifecycle.drain(config.shutdownTimeoutMs);
        await database.close();
      },
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}

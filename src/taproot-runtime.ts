import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  TaprootContentRepositoryV1,
  addAlias,
  addQualifier,
  addReference,
  addStatement,
  createAuthorizedSearchServiceV1,
  createItem,
  createSqliteVectorIndexV1,
  createQdrantVectorIndexV1,
  createOpenAICompatibleEmbeddingProviderV1,
  createOllamaCompatibleEmbeddingProviderV1,
  createProperty,
  removeAlias,
  removeQualifier,
  removeReference,
  removeSitelink,
  removeStatement,
  replaceStatement,
  setDescription,
  setLabel,
  setSitelink,
  setStatementRank,
  type AuthorizationContext,
  type PortableResourcePayloadStoreV1,
  type SearchRequest,
  type SearchResultV1,
  type SemanticSearchAdminV1,
} from '@gnolith/taproot';
import type { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { createSparqlHandler } from '@gnolith/diamond';
import type { WorkshopToolCall, WorkshopToolDispatchContext, WorkshopToolDispatcher, WorkshopToolDefinition } from '@gnolith/workshop/core';
import type { WorkshopSearchIntegrationV1 } from '@gnolith/workshop/server';
import { normalizeWorkshopError, type WorkshopPrincipal } from '@gnolith/workshop/protocol';
import type { ResourcePayloadV1 } from '@gnolith/taproot';
import type { SeedbedAuthorityBundle } from './authorization.js';
import type { SeedbedConfig } from './config.js';
import { createCredentialReader } from './secrets.js';

const publicVisibility = Object.freeze({ version: 1 as const, clauses: Object.freeze([]) });

export interface SeedbedTaprootRuntime {
  readonly content: TaprootContentRepositoryV1;
  readonly semantic: SemanticSearchAdminV1;
  readonly dispatcher: WorkshopToolDispatcher;
  drain(context: AuthorizationContext): Promise<void>;
  close(): Promise<void>;
}

export async function createSeedbedTaprootRuntime(
  db: NodeSqliteDatabase,
  config: SeedbedConfig,
  bundle: SeedbedAuthorityBundle,
  workshop: WorkshopToolDispatcher,
  searchIntegration: WorkshopSearchIntegrationV1,
  resolvePrincipal: () => Promise<AuthorizationContext>,
): Promise<SeedbedTaprootRuntime> {
  const payloadStore = nativePayloadStore(config.blobPath ?? resolve(config.databasePath, '..', 'blobs'));
  const content = new TaprootContentRepositoryV1(db, {
    installationId: bundle.installationId,
    payloadStore,
  });
  const semantic = searchIntegration.semantic;
  const materialization = searchIntegration.materialization;
  const initial = await resolvePrincipal();
  if (initial.capabilities.includes('search:admin')) {
    for (const attachment of config.semanticConfigurations ?? []) {
      const providerOptions = {
        endpoint: attachment.provider.endpoint,
        model: attachment.provider.model,
        dimensions: attachment.provider.dimensions,
        ...(attachment.provider.metric ? { metric: attachment.provider.metric } : {}),
        ...(attachment.provider.allowPrivateEndpoint === undefined ? {} : { allowPrivateEndpoint: attachment.provider.allowPrivateEndpoint }),
        ...(attachment.provider.secret ? { secret: createCredentialReader(attachment.provider.secret)! } : {}),
      };
      const provider = attachment.provider.kind === 'openai-compatible'
        ? createOpenAICompatibleEmbeddingProviderV1(providerOptions)
        : createOllamaCompatibleEmbeddingProviderV1(providerOptions);
      const vectorIndex = attachment.vectorIndex.kind === 'sqlite'
        ? createSqliteVectorIndexV1(db)
        : createQdrantVectorIndexV1({
          endpoint: attachment.vectorIndex.endpoint!,
          collection: attachment.vectorIndex.collection!,
          ...(attachment.vectorIndex.allowPrivateEndpoint === undefined ? {} : { allowPrivateEndpoint: attachment.vectorIndex.allowPrivateEndpoint }),
          ...(attachment.vectorIndex.secret ? { secret: createCredentialReader(attachment.vectorIndex.secret)! } : {}),
        });
      await semantic.configure({
        id: attachment.id,
        name: attachment.name,
        provider,
        vectorIndex,
        ...(attachment.vectorIndex.endpoint ? { vectorEndpoint: attachment.vectorIndex.endpoint } : {}),
      }, initial);
      if (attachment.selected) await semantic.select(attachment.id, initial);
    }
  }
  const search = createAuthorizedSearchServiceV1(db, {
    installationId: bundle.installationId,
    content,
    semantic,
  });
  const sparqlHandler = createSparqlHandler({
    db,
    readOnly: true,
    servicePolicy: () => false,
    maxQueryBytes: 64 * 1024,
    maxResultBytes: 8 * 1024 * 1024,
    maxAlgebraDepth: 64,
    maxAlgebraOperations: 10_000,
    timeoutMs: 10_000,
    exposeErrors: false,
  });

  const taprootTools = toolDefinitions();
  const byName = new Map(taprootTools.map((tool) => [tool.name, tool]));
  const workshopOnlyTools = workshop.tools.filter((tool) => !byName.has(tool.name));
  const backgroundAbort = new AbortController();
  let background: Promise<void> = Promise.resolve();
  const adoptWorkshop = async (principal: AuthorizationContext): Promise<boolean> => {
    const rows = await db.prepare(`SELECT source_kind, state
      FROM taproot_unified_search_producer_adoptions
      WHERE installation_id = ? AND source_kind IN ('task','memory','prompt')
      ORDER BY source_kind`).bind(bundle.installationId).all<{ source_kind: 'task' | 'memory' | 'prompt'; state: string }>();
    for (const row of rows.results.filter(({ state }) => state === 'backfilling')) {
      await searchIntegration[row.source_kind].producer.adoptLegacyPage(principal, { limit: 100 });
    }
    const pending = await db.prepare(`SELECT COUNT(*) AS count
      FROM taproot_unified_search_producer_adoptions
      WHERE installation_id = ? AND source_kind IN ('task','memory','prompt') AND state != 'ready'`)
      .bind(bundle.installationId).all<{ count: number }>();
    return Number(pending.results[0]?.count ?? 0) === 0;
  };
  const advanceMaterialization = async (principal: AuthorizationContext) => {
    const producersReady = await adoptWorkshop(principal);
    let health = await materialization.health(principal);
    if (producersReady && health.shadowCorpusGeneration === null
      && health.blockedProducerKinds.some((kind) => kind === 'task' || kind === 'memory' || kind === 'prompt')) {
      await materialization.startShadowRebuild(principal);
    }
    await materialization.run(principal, { maxJobs: 100, maxRebuildRoots: 100 });
    health = await materialization.health(principal);
    if (health.activeCorpusGeneration === 1 && health.shadowCorpusGeneration !== null
      && health.pendingJobs === 0 && health.leasedJobs === 0 && health.deadJobs === 0) {
      try {
        await materialization.activateReadyShadow(principal);
      } catch {
        // The shadow corpus remains durable and the next bounded pass retries.
      }
    }
  };
  const progress = async () => {
    if (backgroundAbort.signal.aborted) return;
    const principal = await resolvePrincipal();
    if (!principal.capabilities.includes('search:admin')) return;
    await advanceMaterialization(principal);
    const status = await semantic.status(principal);
    for (const plan of status.plans.filter(({ state }) => state === 'approved' || state === 'running')) {
      await semantic.resume(plan.planId, principal, backgroundAbort.signal);
    }
  };
  const timer = setInterval(() => {
    background = background.then(progress).catch(() => undefined);
  }, 1_000);
  timer.unref();
  const dispatcher: WorkshopToolDispatcher = Object.freeze({
    tools: Object.freeze([...workshopOnlyTools, ...taprootTools]),
    listTools(principal: WorkshopPrincipal | null) {
      const base = workshop.listTools(principal);
      if (!base.ok) return base;
      if (!principal) return base;
      return {
        ok: true as const,
        value: Object.freeze([
          ...base.value.filter((tool) => !byName.has(tool.name)),
          ...taprootTools.filter((tool) => principal.capabilities.includes(tool.capability)),
        ]),
      };
    },
    async callTool(call: WorkshopToolCall, context: WorkshopToolDispatchContext) {
      if (!byName.has(call.name)) {
        try {
          const result = await workshop.callTool(call, { ...context, principal: await resolvePrincipal() });
          if (result.ok) {
            const refreshed = await resolvePrincipal();
            if (refreshed.capabilities.includes('search:admin')) {
              await advanceMaterialization(refreshed);
            }
          }
          return result;
        } catch (error) {
          if (isForbidden(error)) return failure('forbidden', 'forbidden', 'Authorization is no longer active');
          const normalized = normalizeWorkshopError(error);
          return failure('operation', normalized.code, normalized.message, normalized.details);
        }
      }
      try {
        const principal = await resolvePrincipal();
        const tool = byName.get(call.name)!;
        if (!principal.capabilities.includes(tool.capability)) {
          return failure('forbidden', 'forbidden', `Exact ${tool.capability} capability is required`);
        }
        const args = objectArguments(call.arguments);
        const value = await callTaprootTool(call.name, args, principal, db, config.baseIri!, bundle, content, search, semantic, materialization, sparqlHandler, context.signal);
        if (call.name.startsWith('content_') || knowledgeWriteToolNames.has(call.name)) {
          const refreshed = await resolvePrincipal();
          if (refreshed.capabilities.includes('search:admin')) {
            await advanceMaterialization(refreshed);
          }
        }
        return { ok: true as const, value };
      } catch (error) {
        const normalized = normalizeWorkshopError(error);
        return failure('operation', normalized.code, normalized.message, normalized.details);
      }
    },
  });

  return Object.freeze({
    content,
    semantic,
    dispatcher,
    async drain(context: AuthorizationContext) {
      if (context.capabilities.includes('search:admin')) {
        await advanceMaterialization(context);
        const status = await semantic.status(context);
        const signal = AbortSignal.timeout(config.shutdownTimeoutMs);
        for (const plan of status.plans.filter(({ state }) => state === 'approved' || state === 'running')) {
          await semantic.resume(plan.planId, context, signal);
        }
      }
    },
    async close() {
      clearInterval(timer);
      backgroundAbort.abort(new Error('Seedbed runtime is closing'));
      await background;
    },
  });
}

function nativePayloadStore(rootInput: string): PortableResourcePayloadStoreV1 {
  const root = resolve(rootInput);
  return Object.freeze({
    kind: 'taproot-resource-payload-store-v1' as const,
    async load(reference: Extract<ResourcePayloadV1, { kind: 'location' }>, signal?: AbortSignal) {
      if (signal?.aborted) throw signal.reason ?? new Error('operation aborted');
      if (reference.storage !== 'blob') throw new Error('native Seedbed loads only installation-owned blob payloads');
      const candidate = resolve(root, reference.location);
      const child = relative(root, candidate);
      if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('blob location escapes the installation store');
      return new Uint8Array(await readFile(candidate));
    },
  });
}

async function callTaprootTool(
  name: string,
  args: Record<string, unknown>,
  context: AuthorizationContext,
  db: NodeSqliteDatabase,
  baseIri: string,
  bundle: SeedbedAuthorityBundle,
  content: TaprootContentRepositoryV1,
  search: WorkshopSearchIntegrationV1['service'],
  semantic: SemanticSearchAdminV1,
  materialization: WorkshopSearchIntegrationV1['materialization'],
  sparqlHandler: ReturnType<typeof createSparqlHandler>,
  signal?: AbortSignal,
): Promise<unknown> {
  const authorization = () => ({
    installationId: context.installationId,
    workspaceId: context.activeWorkspaceId,
    ownerPrincipalId: context.principalId,
    visibility: (args.visibility ?? publicVisibility) as typeof publicVisibility,
    statementRestrictions: (args.statementRestrictions ?? {}) as Readonly<Record<string, readonly (typeof publicVisibility)[]>>,
    expectedAuthorizationRevision: context.authorizationRevision,
  });
  const edit = () => ({
    expectedRevision: requiredInteger(args.expectedRevision, 'expectedRevision'),
    attribution: { id: context.principalId, kind: 'human' as const },
    authorization: authorization(),
  });
  const metadata = () => ({
    context,
    attribution: { id: context.principalId, kind: 'human' as const },
    workspaceId: context.activeWorkspaceId,
    ownerPrincipalId: context.principalId,
    visibility: (args.visibility ?? publicVisibility) as typeof publicVisibility,
    expectedAuthorizationRevision: context.authorizationRevision,
  });
  switch (name) {
    case 'create_item': {
      const { visibility: _visibility, statementRestrictions: _restrictions, ...input } = args;
      return createItem(db, { baseIri }, bundle.authorizationGuard, context, { ...input, attribution: { id: context.principalId, kind: 'human' }, authorization: authorization() } as never);
    }
    case 'create_property': {
      const { visibility: _visibility, statementRestrictions: _restrictions, ...input } = args;
      return createProperty(db, { baseIri }, bundle.authorizationGuard, context, { ...input, attribution: { id: context.principalId, kind: 'human' }, authorization: authorization() } as never);
    }
    case 'set_label': return setLabel(db, { baseIri }, bundle.authorizationGuard, context, requiredString(args.entityId, 'entityId') as never, requiredString(args.language, 'language'), requiredString(args.value, 'value'), edit());
    case 'set_description': return setDescription(db, { baseIri }, bundle.authorizationGuard, context, requiredString(args.entityId, 'entityId') as never, requiredString(args.language, 'language'), requiredString(args.value, 'value'), edit());
    case 'add_alias': return addAlias(db, { baseIri }, bundle.authorizationGuard, context, requiredString(args.entityId, 'entityId') as never, requiredString(args.language, 'language'), requiredString(args.value, 'value'), edit());
    case 'remove_alias': return removeAlias(db, { baseIri }, bundle.authorizationGuard, context, requiredString(args.entityId, 'entityId') as never, requiredString(args.language, 'language'), requiredNonNegativeInteger(args.ordinal, 'ordinal'), edit());
    case 'add_sitelink': return setSitelink(db, { baseIri }, bundle.authorizationGuard, context, requiredString(args.entityId, 'entityId') as never, requiredString(args.site, 'site'), requiredObject(args.sitelink, 'sitelink') as never, edit());
    case 'remove_sitelink': return removeSitelink(db, { baseIri }, bundle.authorizationGuard, context, requiredString(args.entityId, 'entityId') as never, requiredString(args.site, 'site'), edit());
    case 'add_statement': return addStatement(db, { baseIri }, bundle.authorizationGuard, context, requiredString(args.entityId, 'entityId') as never, requiredObject(args.statement, 'statement') as never, edit());
    case 'replace_statement': return replaceStatement(db, { baseIri }, bundle.authorizationGuard, context, requiredString(args.entityId, 'entityId') as never, requiredString(args.statementId, 'statementId'), requiredObject(args.statement, 'statement') as never, edit());
    case 'remove_statement': return removeStatement(db, { baseIri }, bundle.authorizationGuard, context, requiredString(args.entityId, 'entityId') as never, requiredString(args.statementId, 'statementId'), edit());
    case 'set_statement_rank': return setStatementRank(db, { baseIri }, bundle.authorizationGuard, context, requiredString(args.entityId, 'entityId') as never, requiredString(args.statementId, 'statementId'), requiredString(args.rank, 'rank') as never, requiredString(args.text, 'text'), edit());
    case 'add_qualifier': return addQualifier(db, { baseIri }, bundle.authorizationGuard, context, requiredString(args.entityId, 'entityId') as never, requiredString(args.statementId, 'statementId'), requiredObject(args.snak, 'snak') as never, requiredString(args.text, 'text'), edit());
    case 'remove_qualifier': return removeQualifier(db, { baseIri }, bundle.authorizationGuard, context, requiredString(args.entityId, 'entityId') as never, requiredString(args.statementId, 'statementId'), requiredString(args.property, 'property') as never, requiredNonNegativeInteger(args.ordinal, 'ordinal'), requiredString(args.text, 'text'), edit());
    case 'add_reference': return addReference(db, { baseIri }, bundle.authorizationGuard, context, requiredString(args.entityId, 'entityId') as never, requiredString(args.statementId, 'statementId'), requiredObject(args.reference, 'reference') as never, requiredString(args.text, 'text'), edit());
    case 'remove_reference': return removeReference(db, { baseIri }, bundle.authorizationGuard, context, requiredString(args.entityId, 'entityId') as never, requiredString(args.statementId, 'statementId'), requiredString(args.hash, 'hash'), requiredString(args.text, 'text'), edit());
    case 'search': return search.search(args as unknown as SearchRequest, context);
    case 'search_hydrate': return search.hydrate(requiredObject(args.result, 'result') as unknown as SearchResultV1, context);
    case 'content_resource_create': return content.createResource(requiredObject(args.resource, 'resource') as never, metadata());
    case 'content_resource_get': return content.getResource(requiredString(args.id, 'id'), context);
    case 'content_resource_hydrate': return { bytesBase64: Buffer.from(await content.hydrateResourcePayload(requiredString(args.id, 'id'), context, signal)).toString('base64') };
    case 'content_resource_update': return content.updateResource(requiredString(args.id, 'id'), requiredInteger(args.expectedRevision, 'expectedRevision'), requiredObject(args.patch, 'patch') as never, metadata());
    case 'content_resource_delete': return content.deleteResource(requiredString(args.id, 'id'), requiredInteger(args.expectedRevision, 'expectedRevision'), metadata());
    case 'content_annotation_create': return content.createAnnotation(requiredObject(args.annotation, 'annotation') as never, metadata());
    case 'content_annotation_get': return content.getAnnotation(requiredString(args.id, 'id'), context);
    case 'content_annotation_update': return content.updateAnnotation(requiredString(args.id, 'id'), requiredInteger(args.expectedRevision, 'expectedRevision'), requiredObject(args.annotation, 'annotation') as never, metadata());
    case 'content_annotation_delete': return content.deleteAnnotation(requiredString(args.id, 'id'), requiredInteger(args.expectedRevision, 'expectedRevision'), metadata());
    case 'search_admin_health': return materialization.health(context);
    case 'search_admin_run': return materialization.run(context, { maxJobs: optionalBound(args.maxJobs, 100), maxRebuildRoots: optionalBound(args.maxRebuildRoots, 100) });
    case 'search_admin_retry_dead': return { retried: await materialization.retryDead(context, { limit: optionalBound(args.limit, 100) }) };
    case 'search_admin_rebuild': return { shadowCorpusGeneration: await materialization.startShadowRebuild(context) };
    case 'search_admin_activate': return { activeCorpusGeneration: await materialization.activateReadyShadow(context) };
    case 'semantic_status': return semantic.status(context);
    case 'semantic_select': await semantic.select(requiredString(args.configurationId, 'configurationId'), context); return { selected: true };
    case 'semantic_reconnect': return { connected: await semantic.reconnect(requiredString(args.configurationId, 'configurationId'), context) };
    case 'semantic_estimate': return semantic.estimate(requiredString(args.configurationId, 'configurationId'), requiredObject(args.policy, 'policy') as never, context);
    case 'semantic_approve': await semantic.approve(requiredString(args.planId, 'planId'), context); return { approved: true };
    case 'semantic_run': return semantic.run(requiredString(args.planId, 'planId'), context, signal);
    case 'semantic_resume': return semantic.resume(requiredString(args.planId, 'planId'), context, signal);
    case 'semantic_pause': await semantic.pause(requiredString(args.planId, 'planId'), context); return { paused: true };
    case 'semantic_stop': await semantic.stop(requiredString(args.planId, 'planId'), context); return { stopped: true };
    case 'semantic_retry': await semantic.retry(requiredString(args.planId, 'planId'), context); return { retried: true };
    case 'semantic_exclude': await semantic.exclude(requiredString(args.configurationId, 'configurationId'), requiredInteger(args.generation, 'generation'), requiredString(args.derivedId, 'derivedId'), requiredString(args.reason, 'reason'), context); return { excluded: true };
    case 'semantic_retire': await semantic.retire(requiredString(args.configurationId, 'configurationId'), context); return { retired: true };
    case 'semantic_delete': await semantic.deleteEmbeddings(requiredString(args.configurationId, 'configurationId'), context); return { deleted: true };
    case 'sparql_query': {
      for (const capability of ['read', 'knowledge:policy']) {
        if (!context.capabilities.includes(capability)) throw new Error(`Exact ${capability} capability is required for SPARQL administration`);
      }
      const query = requiredString(args.query, 'query');
      const request = new Request(`https://seedbed.invalid/sparql?query=${encodeURIComponent(query)}`, {
        method: 'GET', headers: { accept: typeof args.accept === 'string' ? args.accept : 'application/sparql-results+json' },
        ...(signal === undefined ? {} : { signal }),
      });
      const response = await sparqlHandler(request);
      const body = await response.text();
      if (!response.ok) throw new Error(`SPARQL query failed with status ${response.status}`);
      return { mediaType: response.headers.get('content-type'), body };
    }
    default: throw new Error(`Unknown Taproot tool ${name}`);
  }
}

function toolDefinitions(): readonly WorkshopToolDefinition[] {
  const read = ['search', 'search_hydrate', 'content_resource_get', 'content_resource_hydrate', 'content_annotation_get'] as const;
  const write = ['content_resource_create', 'content_resource_update', 'content_resource_delete', 'content_annotation_create', 'content_annotation_update', 'content_annotation_delete'] as const;
  const knowledgeWrite = [...knowledgeWriteToolNames] as const;
  const admin = ['search_admin_health', 'search_admin_run', 'search_admin_retry_dead', 'search_admin_rebuild', 'search_admin_activate', 'semantic_status', 'semantic_select', 'semantic_reconnect', 'semantic_estimate', 'semantic_approve', 'semantic_run', 'semantic_resume', 'semantic_pause', 'semantic_stop', 'semantic_retry', 'semantic_exclude', 'semantic_retire', 'semantic_delete'] as const;
  const make = (name: string, capability: 'read' | 'knowledge-write' | 'search:admin' | 'admin'): WorkshopToolDefinition => ({
    name,
    title: name.replaceAll('_', ' '),
    description: `Seedbed Taproot ${name.replaceAll('_', ' ')} operation`,
    capability,
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  });
  return Object.freeze([...read.map((name) => make(name, 'read')), ...write.map((name) => make(name, 'knowledge-write')), ...knowledgeWrite.map((name) => make(name, 'knowledge-write')), ...admin.map((name) => make(name, 'search:admin')), make('sparql_query', 'admin')]);
}

const knowledgeWriteToolNames = new Set([
  'create_item', 'create_property', 'set_label', 'set_description', 'add_alias', 'remove_alias',
  'add_sitelink', 'remove_sitelink', 'add_statement', 'replace_statement', 'remove_statement',
  'set_statement_rank', 'add_qualifier', 'remove_qualifier', 'add_reference', 'remove_reference',
]);

function failure(kind: 'forbidden' | 'operation', code: Parameters<typeof normalizeWorkshopError>[0] extends never ? never : 'forbidden' | 'bad_request' | 'validation_failed' | 'unauthenticated' | 'not_found' | 'conflict' | 'limit_exceeded' | 'query_rejected' | 'query_timeout' | 'cancelled' | 'dependency_unavailable' | 'internal_error', message: string, details?: Readonly<Record<string, unknown>>) {
  return { ok: false as const, failure: { kind, error: { code, message, ...(details ? { details } : {}) } } };
}
function objectArguments(value: unknown): Record<string, unknown> { return value && !Array.isArray(value) && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function requiredObject(value: unknown, name: string): Record<string, unknown> { if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${name} must be an object`); return value as Record<string, unknown>; }
function requiredString(value: unknown, name: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`); return value; }
function requiredInteger(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${name} must be a positive integer`); return Number(value); }
function requiredNonNegativeInteger(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${name} must be a non-negative integer`); return Number(value); }
function optionalBound(value: unknown, fallback: number): number { if (value === undefined) return fallback; return requiredInteger(value, 'limit'); }
function isForbidden(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'forbidden'; }

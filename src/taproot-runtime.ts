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
  normalizeCanonicalAuthorizationPolicy,
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
  AuthorizationDeniedError,
  EntityAlreadyExistsError,
  EntityNotFoundError,
  InvalidAuthorizationError,
  InvalidEntityError,
  InvalidStatementError,
  RevisionConflictError,
} from '@gnolith/taproot';
import type { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { createSparqlHandler } from '@gnolith/diamond';
import type { WorkshopToolCall, WorkshopToolDispatchContext, WorkshopToolDispatcher, WorkshopToolDefinition } from '@gnolith/workshop/core';
import type { WorkshopSearchIntegrationV1 } from '@gnolith/workshop/server';
import { normalizeWorkshopError, WorkshopError, type WorkshopPrincipal } from '@gnolith/workshop/protocol';
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
          const principal = await resolvePrincipal();
          const result = await workshop.callTool(call, { ...context, principal });
          if (result.ok) {
            const refreshed = await resolvePrincipal();
            if (workshopHistoryToolNames.has(call.name)
              && refreshed.authorizationRevision !== principal.authorizationRevision) {
              return failure('forbidden', 'forbidden', 'Authorization changed while reading history');
            }
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
        if (historyToolNames.has(call.name)) {
          const refreshed = await resolvePrincipal();
          if (refreshed.authorizationRevision !== principal.authorizationRevision) {
            return failure('forbidden', 'forbidden', 'Authorization changed while reading history');
          }
        }
        if (call.name.startsWith('content_') || knowledgeWriteToolNames.has(call.name)) {
          const refreshed = await resolvePrincipal();
          if (refreshed.capabilities.includes('search:admin')) {
            await advanceMaterialization(refreshed);
          }
        }
        return { ok: true as const, value };
      } catch (error) {
        if (isForbidden(error)) return failure('forbidden', 'forbidden', 'Authorization is no longer active');
        const normalized = normalizeTaprootError(error);
        if (historyToolNames.has(call.name) && normalized.code === 'forbidden') {
          return failure('operation', 'not_found', 'Requested Taproot record was not found');
        }
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
  const creationAuthorization = (statementIds: readonly string[]) => canonicalAuthorization(
    context,
    args.visibility ?? publicVisibility,
    args.statementRestrictions ?? Object.fromEntries(statementIds.map((id) => [id, []])),
    statementIds,
  );
  const edit = async (entityId: string, transform?: (statementIds: string[]) => string[]) => ({
    expectedRevision: requiredInteger(args.expectedRevision, 'expectedRevision'),
    attribution: { id: context.principalId, kind: 'human' as const },
    authorization: await existingEntityAuthorization(db, context, entityId, args, transform),
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
      return createItem(db, { baseIri }, bundle.authorizationGuard, context, { ...input, attribution: { id: context.principalId, kind: 'human' }, authorization: creationAuthorization(statementIdsFromClaims(args.claims)) } as never);
    }
    case 'create_property': {
      const { visibility: _visibility, statementRestrictions: _restrictions, ...input } = args;
      return createProperty(db, { baseIri }, bundle.authorizationGuard, context, { ...input, attribution: { id: context.principalId, kind: 'human' }, authorization: creationAuthorization(statementIdsFromClaims(args.claims)) } as never);
    }
    case 'set_label': { const id = requiredString(args.entityId, 'entityId'); return setLabel(db, { baseIri }, bundle.authorizationGuard, context, id as never, requiredString(args.language, 'language'), requiredString(args.value, 'value'), await edit(id)); }
    case 'set_description': { const id = requiredString(args.entityId, 'entityId'); return setDescription(db, { baseIri }, bundle.authorizationGuard, context, id as never, requiredString(args.language, 'language'), requiredString(args.value, 'value'), await edit(id)); }
    case 'add_alias': { const id = requiredString(args.entityId, 'entityId'); return addAlias(db, { baseIri }, bundle.authorizationGuard, context, id as never, requiredString(args.language, 'language'), requiredString(args.value, 'value'), await edit(id)); }
    case 'remove_alias': { const id = requiredString(args.entityId, 'entityId'); return removeAlias(db, { baseIri }, bundle.authorizationGuard, context, id as never, requiredString(args.language, 'language'), requiredNonNegativeInteger(args.ordinal, 'ordinal'), await edit(id)); }
    case 'add_sitelink': { const id = requiredString(args.entityId, 'entityId'); return setSitelink(db, { baseIri }, bundle.authorizationGuard, context, id as never, requiredString(args.site, 'site'), requiredObject(args.sitelink, 'sitelink') as never, await edit(id)); }
    case 'remove_sitelink': { const id = requiredString(args.entityId, 'entityId'); return removeSitelink(db, { baseIri }, bundle.authorizationGuard, context, id as never, requiredString(args.site, 'site'), await edit(id)); }
    case 'add_statement': {
      const id = requiredString(args.entityId, 'entityId');
      const statement = requiredObject(args.statement, 'statement');
      const statementId = requiredString(statement.id, 'statement.id');
      return addStatement(db, { baseIri }, bundle.authorizationGuard, context, id as never, statement as never, await edit(id, (ids) => [...ids, statementId]));
    }
    case 'replace_statement': { const id = requiredString(args.entityId, 'entityId'); return replaceStatement(db, { baseIri }, bundle.authorizationGuard, context, id as never, requiredString(args.statementId, 'statementId'), requiredObject(args.statement, 'statement') as never, await edit(id)); }
    case 'remove_statement': { const id = requiredString(args.entityId, 'entityId'); const statementId = requiredString(args.statementId, 'statementId'); return removeStatement(db, { baseIri }, bundle.authorizationGuard, context, id as never, statementId, await edit(id, (ids) => ids.filter((value) => value !== statementId))); }
    case 'set_statement_rank': { const id = requiredString(args.entityId, 'entityId'); return setStatementRank(db, { baseIri }, bundle.authorizationGuard, context, id as never, requiredString(args.statementId, 'statementId'), requiredString(args.rank, 'rank') as never, requiredString(args.text, 'text'), await edit(id)); }
    case 'add_qualifier': { const id = requiredString(args.entityId, 'entityId'); return addQualifier(db, { baseIri }, bundle.authorizationGuard, context, id as never, requiredString(args.statementId, 'statementId'), requiredObject(args.snak, 'snak') as never, requiredString(args.text, 'text'), await edit(id)); }
    case 'remove_qualifier': { const id = requiredString(args.entityId, 'entityId'); return removeQualifier(db, { baseIri }, bundle.authorizationGuard, context, id as never, requiredString(args.statementId, 'statementId'), requiredString(args.property, 'property') as never, requiredNonNegativeInteger(args.ordinal, 'ordinal'), requiredString(args.text, 'text'), await edit(id)); }
    case 'add_reference': { const id = requiredString(args.entityId, 'entityId'); return addReference(db, { baseIri }, bundle.authorizationGuard, context, id as never, requiredString(args.statementId, 'statementId'), requiredObject(args.reference, 'reference') as never, requiredString(args.text, 'text'), await edit(id)); }
    case 'remove_reference': { const id = requiredString(args.entityId, 'entityId'); return removeReference(db, { baseIri }, bundle.authorizationGuard, context, id as never, requiredString(args.statementId, 'statementId'), requiredString(args.hash, 'hash'), requiredString(args.text, 'text'), await edit(id)); }
    case 'item_history': return bundle.authorizedReader(context).listEntityRevisions(requiredString(args.entityId, 'entityId') as never, {
      limit: historyLimit(args.limit),
      ...(args.cursor === undefined ? {} : { cursor: requiredString(args.cursor, 'cursor') }),
    });
    case 'item_revision': return bundle.authorizedReader(context).getEntityRevision(
      requiredString(args.entityId, 'entityId') as never,
      requiredInteger(args.revision, 'revision'),
    );
    case 'statement_history': {
      const entityId = requiredString(args.entityId, 'entityId');
      const statementId = requiredString(args.statementId, 'statementId');
      const page = await bundle.authorizedReader(context).listEntityRevisions(entityId as never, {
        limit: historyLimit(args.limit),
        ...(args.cursor === undefined ? {} : { cursor: requiredString(args.cursor, 'cursor') }),
      });
      return { ...page, items: page.items.map((revision) => ({ ...revision, statement: statementFromEntity(revision.entity, statementId) })) };
    }
    case 'statement_revision': {
      const statementId = requiredString(args.statementId, 'statementId');
      const revision = await bundle.authorizedReader(context).getEntityRevision(
        requiredString(args.entityId, 'entityId') as never,
        requiredInteger(args.revision, 'revision'),
      );
      return { ...revision, statement: statementFromEntity(revision.entity, statementId) };
    }
    case 'resource_history': return contentHistory(db, content, 'resource', requiredString(args.id, 'id'), historyLimit(args.limit), context);
    case 'resource_revision': return content.getResourceRevision(requiredString(args.id, 'id'), requiredInteger(args.revision, 'revision'), context);
    case 'annotation_history': return contentHistory(db, content, 'annotation', requiredString(args.id, 'id'), historyLimit(args.limit), context);
    case 'annotation_revision': return content.getAnnotationRevision(requiredString(args.id, 'id'), requiredInteger(args.revision, 'revision'), context);
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
    case 'validate_sparql':
    case 'dry_run_sparql':
    case 'query_sparql': {
      const query = requiredString(args.query, 'query');
      const request = new Request(`https://seedbed.invalid/sparql?query=${encodeURIComponent(query)}`, {
        method: 'GET', headers: { accept: typeof args.accept === 'string' ? args.accept : 'application/sparql-results+json' },
        ...(signal === undefined ? {} : { signal }),
      });
      const response = await sparqlHandler(request);
      const body = await response.text();
      if (!response.ok) throw new Error(`SPARQL query failed with status ${response.status}`);
      if (name !== 'query_sparql') return { valid: true, dryRun: name === 'dry_run_sparql', mediaType: response.headers.get('content-type') };
      return { mediaType: response.headers.get('content-type'), body };
    }
    default: throw new Error(`Unknown Taproot tool ${name}`);
  }
}

function toolDefinitions(): readonly WorkshopToolDefinition[] {
  const read = ['search', 'search_hydrate', 'content_resource_get', 'content_resource_hydrate', 'content_annotation_get',
    'item_history', 'item_revision', 'statement_history', 'statement_revision',
    'resource_history', 'resource_revision', 'annotation_history', 'annotation_revision'] as const;
  const write = ['content_resource_create', 'content_resource_update', 'content_resource_delete', 'content_annotation_create', 'content_annotation_update', 'content_annotation_delete'] as const;
  const knowledgeWrite = [...knowledgeWriteToolNames] as const;
  const admin = ['search_admin_health', 'search_admin_run', 'search_admin_retry_dead', 'search_admin_rebuild', 'search_admin_activate', 'semantic_status', 'semantic_select', 'semantic_reconnect', 'semantic_estimate', 'semantic_approve', 'semantic_run', 'semantic_resume', 'semantic_pause', 'semantic_stop', 'semantic_retry', 'semantic_exclude', 'semantic_retire', 'semantic_delete'] as const;
  const make = (name: string, capability: 'read' | 'knowledge:write' | 'search:admin'): WorkshopToolDefinition => ({
    name,
    title: name.replaceAll('_', ' '),
    description: `Seedbed Taproot ${name.replaceAll('_', ' ')} operation`,
    capability: capability as WorkshopToolDefinition['capability'],
    inputSchema: inputSchemaFor(name),
  });
  const sparql = ['validate_sparql', 'dry_run_sparql', 'query_sparql'] as const;
  return Object.freeze([...read.map((name) => make(name, 'read')), ...write.map((name) => make(name, 'knowledge:write')), ...knowledgeWrite.map((name) => make(name, 'knowledge:write')), ...admin.map((name) => make(name, 'search:admin')), ...sparql.map((name) => make(name, 'read'))]);
}

const historyToolNames = new Set([
  'item_history', 'item_revision', 'statement_history', 'statement_revision',
  'resource_history', 'resource_revision', 'annotation_history', 'annotation_revision',
]);
const workshopHistoryToolNames = new Set(['task_history', 'memory_history', 'prompt_history']);

const knowledgeWriteToolNames = new Set([
  'create_item', 'create_property', 'set_label', 'set_description', 'add_alias', 'remove_alias',
  'add_sitelink', 'remove_sitelink', 'add_statement', 'replace_statement', 'remove_statement',
  'set_statement_rank', 'add_qualifier', 'remove_qualifier', 'add_reference', 'remove_reference',
]);

async function existingEntityAuthorization(
  db: NodeSqliteDatabase,
  context: AuthorizationContext,
  entityId: string,
  args: Record<string, unknown>,
  transform?: (statementIds: string[]) => string[],
) {
  const authorization = await db.prepare(`SELECT visibility_json, workspace_id, owner_principal_id
    FROM taproot_entity_authorization
    WHERE entity_id = ? AND installation_id = ? AND deleted_at IS NULL`)
    .bind(entityId, context.installationId).all<{ visibility_json: string; workspace_id: string | null; owner_principal_id: string }>();
  const current = authorization.results[0];
  if (!current) throw new EntityNotFoundError('Entity is missing or inaccessible');
  const rows = await db.prepare(`SELECT statement_id, restrictions_json
    FROM taproot_statement_authorization
    WHERE entity_id = ? ORDER BY statement_id`).bind(entityId)
    .all<{ statement_id: string; restrictions_json: string }>();
  const existing = Object.fromEntries(rows.results.map((row) => [row.statement_id, JSON.parse(row.restrictions_json)]));
  const statementIds = transform ? transform(Object.keys(existing)) : Object.keys(existing);
  if (new Set(statementIds).size !== statementIds.length) {
    throw new WorkshopError('validation_failed', 'Statement authorization keys must be unique');
  }
  const preserved = Object.fromEntries(statementIds.map((id) => [id, existing[id] ?? []]));
  return canonicalAuthorization(
    context,
    args.visibility ?? JSON.parse(current.visibility_json),
    args.statementRestrictions ?? preserved,
    statementIds,
    { workspaceId: current.workspace_id, ownerPrincipalId: current.owner_principal_id },
  );
}

function canonicalAuthorization(
  context: AuthorizationContext,
  visibility: unknown,
  restrictions: unknown,
  statementIds: readonly string[],
  identity: { workspaceId: string | null; ownerPrincipalId: string } = {
    workspaceId: context.activeWorkspaceId,
    ownerPrincipalId: context.principalId,
  },
) {
  if (!visibility || Array.isArray(visibility) || typeof visibility !== 'object') {
    throw new WorkshopError('validation_failed', 'visibility must be a canonical visibility object');
  }
  if (!restrictions || Array.isArray(restrictions) || typeof restrictions !== 'object') {
    throw new WorkshopError('validation_failed', 'statementRestrictions must be a complete object');
  }
  const expected = [...statementIds].sort();
  const actual = Object.keys(restrictions as Record<string, unknown>).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new WorkshopError('validation_failed', 'statementRestrictions keys must exactly match the post-mutation statements', 400, {
      expectedStatementIds: expected,
    });
  }
  let normalized;
  try {
    normalized = normalizeCanonicalAuthorizationPolicy({
      installationId: context.installationId,
      workspaceId: identity.workspaceId,
      ownerPrincipalId: identity.ownerPrincipalId,
      visibility,
      statementRestrictions: restrictions,
      expectedAuthorizationRevision: context.authorizationRevision,
    } as never);
  } catch (error) {
    throw new WorkshopError('validation_failed', boundedMessage(error, 'Invalid canonical authorization policy'));
  }
  return normalized;
}

function statementIdsFromClaims(value: unknown): string[] {
  if (value === undefined) return [];
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new WorkshopError('validation_failed', 'claims must be an object grouped by property ID');
  }
  const ids: string[] = [];
  for (const statements of Object.values(value as Record<string, unknown>)) {
    if (!Array.isArray(statements)) throw new WorkshopError('validation_failed', 'Each claims entry must be an array');
    for (const statement of statements) {
      if (!statement || Array.isArray(statement) || typeof statement !== 'object') {
        throw new WorkshopError('validation_failed', 'Each claim must be a statement object');
      }
      ids.push(requiredString((statement as Record<string, unknown>).id, 'statement.id'));
    }
  }
  if (new Set(ids).size !== ids.length) throw new WorkshopError('validation_failed', 'Statement IDs must be unique');
  return ids;
}

function statementFromEntity(entity: unknown, statementId: string): unknown {
  if (!entity || Array.isArray(entity) || typeof entity !== 'object') return null;
  const claims = (entity as Record<string, unknown>).claims;
  if (!claims || Array.isArray(claims) || typeof claims !== 'object') return null;
  for (const statements of Object.values(claims as Record<string, unknown>)) {
    if (!Array.isArray(statements)) continue;
    const found = statements.find((statement) => !!statement && typeof statement === 'object'
      && !Array.isArray(statement) && (statement as Record<string, unknown>).id === statementId);
    if (found) return found;
  }
  return null;
}

async function contentHistory(
  db: NodeSqliteDatabase,
  content: TaprootContentRepositoryV1,
  kind: 'resource' | 'annotation',
  id: string,
  limit: number,
  context: AuthorizationContext,
): Promise<{ items: unknown[] }> {
  const rows = await db.prepare(`SELECT revision FROM taproot_content_revisions
    WHERE record_kind = ? AND record_id = ? ORDER BY revision DESC LIMIT ?`)
    .bind(kind, id, limit).all<{ revision: number }>();
  if (rows.results.length === 0) throw new EntityNotFoundError('Record is missing or inaccessible');
  const items = [];
  for (const row of rows.results) {
    items.push(kind === 'resource'
      ? await content.getResourceRevision(id, Number(row.revision), context)
      : await content.getAnnotationRevision(id, Number(row.revision), context));
  }
  return { items };
}

function historyLimit(value: unknown): number {
  if (value === undefined) return 20;
  const limit = requiredInteger(value, 'limit');
  if (limit > 100) throw new WorkshopError('limit_exceeded', 'History limit cannot exceed 100');
  return limit;
}

function inputSchemaFor(name: string): WorkshopToolDefinition['inputSchema'] {
  const string = (description: string) => ({ type: 'string', minLength: 1, description });
  const positive = (description: string) => ({ type: 'integer', minimum: 1, description });
  const object = (description: string) => ({ type: 'object', description, additionalProperties: true });
  const policy = {
    visibility: object('Canonical entity visibility scope.'),
    statementRestrictions: object('Complete statement-ID to visibility-scope-array map for the post-mutation revision. Omit on an existing entity to preserve its canonical current map.'),
  };
  const edit = { expectedRevision: positive('Exact current entity revision.'), ...policy };
  const schemas: Record<string, { properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }> = {
    create_item: { properties: { id: string('Optional Q item ID.'), labels: object('Language label map.'), descriptions: object('Language description map.'), aliases: object('Language alias map.'), claims: object('Statements grouped by property ID.'), sitelinks: object('Sitelinks keyed by site.'), ...policy } },
    create_property: { properties: { id: string('Optional P property ID.'), datatype: string('Property datatype.'), labels: object('Language label map.'), descriptions: object('Language description map.'), aliases: object('Language alias map.'), claims: object('Statements grouped by property ID.'), ...policy }, required: ['datatype'] },
    set_label: { properties: { entityId: string('Entity ID.'), language: string('BCP 47 language code.'), value: string('Label value.'), ...edit }, required: ['entityId', 'language', 'value', 'expectedRevision'] },
    set_description: { properties: { entityId: string('Entity ID.'), language: string('BCP 47 language code.'), value: string('Description value.'), ...edit }, required: ['entityId', 'language', 'value', 'expectedRevision'] },
    add_alias: { properties: { entityId: string('Entity ID.'), language: string('BCP 47 language code.'), value: string('Alias value.'), ...edit }, required: ['entityId', 'language', 'value', 'expectedRevision'] },
    remove_alias: { properties: { entityId: string('Entity ID.'), language: string('BCP 47 language code.'), ordinal: { type: 'integer', minimum: 0 }, ...edit }, required: ['entityId', 'language', 'ordinal', 'expectedRevision'] },
    add_sitelink: { properties: { entityId: string('Item ID.'), site: string('Site key.'), sitelink: object('Complete sitelink.'), ...edit }, required: ['entityId', 'site', 'sitelink', 'expectedRevision'] },
    remove_sitelink: { properties: { entityId: string('Item ID.'), site: string('Site key.'), ...edit }, required: ['entityId', 'site', 'expectedRevision'] },
    add_statement: { properties: { entityId: string('Entity ID.'), statement: object('Complete statement with stable ID and authored text.'), ...edit }, required: ['entityId', 'statement', 'expectedRevision'] },
    replace_statement: { properties: { entityId: string('Entity ID.'), statementId: string('Current statement ID.'), statement: object('Complete replacement statement.'), ...edit }, required: ['entityId', 'statementId', 'statement', 'expectedRevision'] },
    remove_statement: { properties: { entityId: string('Entity ID.'), statementId: string('Statement ID.'), ...edit }, required: ['entityId', 'statementId', 'expectedRevision'] },
    set_statement_rank: { properties: { entityId: string('Entity ID.'), statementId: string('Statement ID.'), rank: { type: 'string', enum: ['preferred', 'normal', 'deprecated'] }, text: string('Authored revision text.'), ...edit }, required: ['entityId', 'statementId', 'rank', 'text', 'expectedRevision'] },
    add_qualifier: { properties: { entityId: string('Entity ID.'), statementId: string('Statement ID.'), snak: object('Typed qualifier snak.'), text: string('Authored revision text.'), ...edit }, required: ['entityId', 'statementId', 'snak', 'text', 'expectedRevision'] },
    remove_qualifier: { properties: { entityId: string('Entity ID.'), statementId: string('Statement ID.'), property: string('Qualifier property ID.'), ordinal: { type: 'integer', minimum: 0 }, text: string('Authored revision text.'), ...edit }, required: ['entityId', 'statementId', 'property', 'ordinal', 'text', 'expectedRevision'] },
    add_reference: { properties: { entityId: string('Entity ID.'), statementId: string('Statement ID.'), reference: object('Complete reference.'), text: string('Authored revision text.'), ...edit }, required: ['entityId', 'statementId', 'reference', 'text', 'expectedRevision'] },
    remove_reference: { properties: { entityId: string('Entity ID.'), statementId: string('Statement ID.'), hash: string('Reference hash.'), text: string('Authored revision text.'), ...edit }, required: ['entityId', 'statementId', 'hash', 'text', 'expectedRevision'] },
    item_history: { properties: { entityId: string('Item ID.'), limit: positive('Maximum revisions, at most 100.'), cursor: string('Opaque continuation cursor.') }, required: ['entityId'] },
    item_revision: { properties: { entityId: string('Item ID.'), revision: positive('Exact revision.') }, required: ['entityId', 'revision'] },
    statement_history: { properties: { entityId: string('Owning entity ID.'), statementId: string('Statement ID.'), limit: positive('Maximum entity revisions, at most 100.'), cursor: string('Opaque continuation cursor.') }, required: ['entityId', 'statementId'] },
    statement_revision: { properties: { entityId: string('Owning entity ID.'), statementId: string('Statement ID.'), revision: positive('Exact entity revision.') }, required: ['entityId', 'statementId', 'revision'] },
    resource_history: { properties: { id: string('Resource ID.'), limit: positive('Maximum revisions, at most 100.') }, required: ['id'] },
    resource_revision: { properties: { id: string('Resource ID.'), revision: positive('Exact revision.') }, required: ['id', 'revision'] },
    annotation_history: { properties: { id: string('Annotation ID.'), limit: positive('Maximum revisions, at most 100.') }, required: ['id'] },
    annotation_revision: { properties: { id: string('Annotation ID.'), revision: positive('Exact revision.') }, required: ['id', 'revision'] },
    search: { properties: { text: string('Search text.'), kinds: { type: 'array', items: string('Unified kind.') }, filters: object('Structured filters.'), limit: positive('Page size.'), cursor: string('Opaque cursor.') }, required: ['text'] },
    search_hydrate: { properties: { result: object('Exact search result returned by search.') }, required: ['result'] },
    content_resource_create: { properties: { resource: object('Complete resource input.'), visibility: object('Canonical visibility scope.') }, required: ['resource'] },
    content_resource_get: { properties: { id: string('Resource ID.') }, required: ['id'] },
    content_resource_hydrate: { properties: { id: string('Resource ID.') }, required: ['id'] },
    content_resource_update: { properties: { id: string('Resource ID.'), expectedRevision: positive('Exact current revision.'), patch: object('Resource patch.'), visibility: object('Canonical visibility scope.') }, required: ['id', 'expectedRevision', 'patch'] },
    content_resource_delete: { properties: { id: string('Resource ID.'), expectedRevision: positive('Exact current revision.'), visibility: object('Canonical visibility scope.') }, required: ['id', 'expectedRevision'] },
    content_annotation_create: { properties: { annotation: object('Complete annotation input.'), visibility: object('Canonical visibility scope.') }, required: ['annotation'] },
    content_annotation_get: { properties: { id: string('Annotation ID.') }, required: ['id'] },
    content_annotation_update: { properties: { id: string('Annotation ID.'), expectedRevision: positive('Exact current revision.'), annotation: object('Complete annotation input.'), visibility: object('Canonical visibility scope.') }, required: ['id', 'expectedRevision', 'annotation'] },
    content_annotation_delete: { properties: { id: string('Annotation ID.'), expectedRevision: positive('Exact current revision.'), visibility: object('Canonical visibility scope.') }, required: ['id', 'expectedRevision'] },
    validate_sparql: { properties: { query: string('Read-only SPARQL query.'), accept: string('Response media type.') }, required: ['query'] },
    dry_run_sparql: { properties: { query: string('Read-only SPARQL query.'), accept: string('Response media type.') }, required: ['query'] },
    query_sparql: { properties: { query: string('Read-only SPARQL query.'), accept: string('Response media type.') }, required: ['query'] },
  };
  const adminProperties: Record<string, Record<string, unknown>> = {
    search_admin_run: { maxJobs: positive('Maximum jobs.'), maxRebuildRoots: positive('Maximum roots.') },
    search_admin_retry_dead: { limit: positive('Maximum dead jobs.') },
    semantic_select: { configurationId: string('Configuration ID.') }, semantic_reconnect: { configurationId: string('Configuration ID.') },
    semantic_estimate: { configurationId: string('Configuration ID.'), policy: object('Embedding budget policy.') },
    semantic_approve: { planId: string('Plan ID.') }, semantic_run: { planId: string('Plan ID.') }, semantic_resume: { planId: string('Plan ID.') }, semantic_pause: { planId: string('Plan ID.') }, semantic_stop: { planId: string('Plan ID.') }, semantic_retry: { planId: string('Plan ID.') },
    semantic_exclude: { configurationId: string('Configuration ID.'), generation: positive('Generation.'), derivedId: string('Derived ID.'), reason: string('Exclusion reason.') },
    semantic_retire: { configurationId: string('Configuration ID.') }, semantic_delete: { configurationId: string('Configuration ID.') },
  };
  const schema = schemas[name] ?? (adminProperties[name] ? { properties: adminProperties[name] } : { properties: {} });
  return { type: 'object', properties: schema.properties, ...(schema.required?.length ? { required: schema.required } : {}), additionalProperties: schema.additionalProperties ?? false };
}

function normalizeTaprootError(error: unknown): WorkshopError {
  if (error instanceof WorkshopError) return error;
  if (error instanceof AuthorizationDeniedError || error instanceof InvalidAuthorizationError
    || (error instanceof Error && /authorization (?:denied|fence is stale|revision mismatch)/iu.test(error.message))) {
    return new WorkshopError('forbidden', 'Authorization is no longer valid');
  }
  if (error instanceof EntityNotFoundError || (error instanceof Error && /not found|missing or inaccessible/iu.test(error.message))) {
    return new WorkshopError('not_found', 'Requested Taproot record was not found');
  }
  if (error instanceof RevisionConflictError || error instanceof EntityAlreadyExistsError
    || (error instanceof Error && /revision conflict|already exists/iu.test(error.message))) {
    return new WorkshopError('conflict', boundedMessage(error, 'Taproot revision conflict'));
  }
  if (error instanceof InvalidEntityError || error instanceof InvalidStatementError
    || (error instanceof Error && /invalid|mismatch|must |cannot exceed/iu.test(error.message))) {
    return new WorkshopError('validation_failed', boundedMessage(error, 'Taproot validation failed'));
  }
  return new WorkshopError('internal_error', 'Taproot operation failed');
}

function boundedMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : '';
  return message ? message.slice(0, 256) : fallback;
}

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

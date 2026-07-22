import type { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import { createWorkshopCore, createWorkshopToolDispatcher } from '@gnolith/workshop/core';
import type { WorkshopToolDispatcher } from '@gnolith/workshop/core';
import type { AuthorizationContext } from '@gnolith/workshop/protocol';
import type { SeedbedConfig } from './config.js';
import { ExitCode, SeedbedError } from './errors.js';
import { OperationLifecycle } from './lifecycle.js';
import { requireReady, type TaprootAssembly } from './persistence.js';
import { openAuthorization } from './authorization.js';

export interface SeedbedRuntime {
  readonly database: NodeSqliteDatabase;
  readonly dispatcher: WorkshopToolDispatcher;
  readonly principal: AuthorizationContext;
  readonly lifecycle: OperationLifecycle;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export async function createSeedbedRuntime(config: SeedbedConfig, taproot: TaprootAssembly): Promise<SeedbedRuntime> {
  if (!config.principalSelector) throw selectorError('A principal selector is required for runtime commands');
  const database = await requireReady(config, taproot);
  try {
    const bundle = await openAuthorization(database, config);
    const principal = await bundle.resolveContext(config.principalSelector, config.workspaceSelector);
    const core = createWorkshopCore({
      persistence: bundle.persistence,
      authorization: bundle.authority,
      cursorCodec: bundle.cursorCodec,
      knowledge: {
        authorizedReader: (context) => bundle.authorizedReader(context),
        health: async () => (await bundle.authority.getInstallationAuthorizationState()) !== null,
      },
      diamondHealth: () => true,
    });
    const dispatcher = createWorkshopToolDispatcher(core);
    const lifecycle = new OperationLifecycle();
    return {
      database,
      dispatcher,
      principal,
      lifecycle,
      async drain() { await lifecycle.drain(config.shutdownTimeoutMs); },
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

function selectorError(message: string): SeedbedError {
  return new SeedbedError(message, ExitCode.configuration, 'selector_required');
}

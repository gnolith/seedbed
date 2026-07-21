import {
  TaprootRepository,
  applyTaprootMigrations,
  canonicalizeTaprootBaseIri,
  inspectTaprootPersistence,
} from '@gnolith/taproot';
import { createTaprootKnowledgeService, type TaprootRepositoryLike } from '@gnolith/workshop/server';
import type { TaprootAssembly } from './persistence.js';

const taprootAssembly: TaprootAssembly = {
  version: '0.2.0',
  async migrate(db, baseIri) {
    await applyTaprootMigrations(db, { baseIri });
  },
  async inspect(db, baseIri) {
    const inspection = await inspectTaprootPersistence(db);
    const expected = canonicalizeTaprootBaseIri(baseIri);
    if (!inspection.current) {
      return { ready: false, detail: 'Taproot migrations or semantic schema verification are not current' };
    }
    if (inspection.baseIri !== expected) {
      return {
        ready: false,
        detail: `Taproot base IRI ${inspection.baseIri ?? '(missing)'} does not match configured identity ${expected}`,
      };
    }
    return { ready: true };
  },
  createKnowledgeService(db, baseIri) {
    const repository = new TaprootRepository(db, { baseIri });
    // Workshop intentionally publishes a structural repository port so the
    // packages remain independently versioned.
    return createTaprootKnowledgeService(repository as unknown as TaprootRepositoryLike);
  },
};

export async function loadTaprootAssembly(): Promise<TaprootAssembly> {
  return taprootAssembly;
}


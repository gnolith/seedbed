import {
  applyTaprootMigrations,
  canonicalizeTaprootBaseIri,
  inspectTaprootPersistence,
} from '@gnolith/taproot';
import type { TaprootAssembly } from './persistence.js';

const taprootAssembly: TaprootAssembly = {
  version: '0.4.1',
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
};

export async function loadTaprootAssembly(): Promise<TaprootAssembly> {
  return taprootAssembly;
}


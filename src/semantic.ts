import { canonicalJson, sha256 } from './canonical.js';
import type { SemanticConfigurationV1 } from './types.js';

/**
 * Mirrors Taproot's frozen semantic fingerprint boundary. Human-facing id/name
 * and protected selector bytes are deliberately outside the digest.
 */
export function semanticConfigurationFingerprint(configuration: SemanticConfigurationV1): string {
  return sha256(canonicalJson({
    version: 1,
    provider: configuration.provider,
    vector: configuration.vector,
  }));
}

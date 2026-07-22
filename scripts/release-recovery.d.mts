export type RecoveryInventoryEntry = { path: string; bytes: number; sha256: string };
export function getV022RecoveryPlan(tag: string): {
  tag: string;
  commit: string;
  version: string;
  runId: string;
  workflowId: string;
  workflowBlob: string;
  inventory: readonly RecoveryInventoryEntry[];
  artifacts: readonly { id: string; name: string; digest: string; size: number; expiresAt: string; directory: string }[];
  releaseEvidenceSha256: string;
};
export function validateV022RecoveryInventory(
  tag: string,
  inventory: readonly RecoveryInventoryEntry[],
): readonly RecoveryInventoryEntry[];

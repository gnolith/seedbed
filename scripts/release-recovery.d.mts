export type RecoveryInventoryEntry = { path: string; bytes: number; sha256: string };
export function getV022RecoveryPlan(tag: string): {
  tag: string;
  commit: string;
  version: string;
  runId: string;
  workflowId: string;
  workflowBlob: string;
  npmSha256: string;
  npmIntegrity: string;
  npmShasum: string;
  npmTarballUrl: string;
  npmFileCount: number;
  npmUnpackedSize: number;
  npmSignatureKeyId: string;
  npmSignature: string;
  closureSha256: string;
  imageDigest: string;
  imageSbomSha256: string;
  imageManifestSha256: string;
  provenanceEvidenceSha256: string;
  npmAttestationsUrl: string;
  priorLatestReleaseTag: string;
  repositoryId: string;
  repositoryOwnerId: string;
  builderId: string;
  invocationId: string;
  dsseSignature: string;
  verificationMaterialSha256: string;
  tlogIndex: string;
  tlogIntegratedTime: string;
  jobs: readonly { id: string; name: string; conclusion: string }[];
  inventory: readonly RecoveryInventoryEntry[];
  artifacts: readonly { id: string; name: string; digest: string; size: number; expiresAt: string; directory: string }[];
  releaseEvidenceSha256: string;
};
export function getV022ReleaseAssetNames(tag: string): string[];
export function getV022ReleaseCopies(tag: string): Array<[string, string]>;
export function validateV022NpmMetadata(tag: string, metadata: unknown): void;
export function validateV022NpmProvenance(tag: string, response: unknown): void;
export function validateNpmProvenanceIdentity(
  expected: ReturnType<typeof getV022RecoveryPlan>,
  response: unknown,
): void;
export function decideV022ReleaseRecovery(
  tag: string,
  firstState: string,
  secondState: string,
  draftCount: number,
  latestTag: string,
): 'create' | 'verify';
export function validateV022ReleaseSnapshot(tag: string, release: unknown): void;
export function countV022DraftReleases(tag: string, pages: unknown): number;
export function fetchV022DraftCount(
  tag: string,
  apiUrl: string,
  token: string | undefined,
  fetchImpl?: typeof fetch,
): Promise<number>;
export function validateV022RecoveryInventory(
  tag: string,
  inventory: readonly RecoveryInventoryEntry[],
): readonly RecoveryInventoryEntry[];
export function stageV022RecoveryAssets(tag: string, root: string, destination: string): Promise<string[]>;
export function stageRecoveryAssetsFromDefinition(
  definition: ReturnType<typeof getV022RecoveryPlan>,
  copies: readonly (readonly [string, string])[],
  root: string,
  destination: string,
): Promise<string[]>;

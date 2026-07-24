export const OWNER_ORDER = ['diamond', 'taproot', 'workshop'] as const;
export type OwnerName = typeof OWNER_ORDER[number];
export const OWNER_LEDGER_NAMESPACES: Readonly<Record<OwnerName, string>> = {
  diamond: '@gnolith/diamond',
  taproot: '@gnolith/taproot',
  workshop: '@gnolith/workshop',
};

export interface ImmutableCoordinate {
  readonly version: string;
  readonly artifact: string;
  readonly sha256: string;
  readonly sourceCommit: string;
}

export interface SecretSelector {
  readonly kind: 'protected-file' | 'inherited-fd' | 'environment';
  readonly value: string;
}

export interface SemanticConfigurationV1 {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly provider: {
    readonly kind: 'openai-compatible' | 'ollama-compatible';
    readonly endpoint: string;
    readonly model: string;
    readonly dimensions: number;
    readonly metric: 'cosine' | 'dot' | 'euclid';
    readonly credentialSelector: string | null;
    readonly allowPrivateEndpoint: boolean;
    readonly redirectPolicy: 'error';
  };
  readonly vector: {
    readonly kind: 'sqlite';
  } | {
    readonly kind: 'qdrant';
    readonly endpoint: string;
    readonly collection: string;
    readonly credentialSelector: string | null;
    readonly allowPrivateEndpoint: boolean;
    readonly redirectPolicy: 'error';
  };
}

export interface ProtectedSemanticSelectorV1 {
  readonly id: string;
  readonly kind: 'protected-file-v1';
  readonly path: string;
}

export interface SeedbedSemanticConfigurationV1 {
  readonly configuration: SemanticConfigurationV1;
  readonly expectedRevision: number;
  readonly credentialSelectors: readonly ProtectedSemanticSelectorV1[];
}

export interface SemanticConfigurationReceiptV1 {
  readonly fingerprint: string;
  readonly revision: number;
  readonly state: string;
}

export interface SeedbedConfig {
  readonly formatVersion: 1;
  readonly installationId: string;
  readonly baseIri: string;
  readonly packages: {
    readonly diamond: ImmutableCoordinate;
    readonly taproot: ImmutableCoordinate;
    readonly workshop: ImmutableCoordinate;
    readonly waystone?: ImmutableCoordinate;
  };
  readonly compose: {
    readonly projectName: string;
    readonly workshopPort: number;
    readonly publishIpv6Loopback: boolean;
    readonly profiles: readonly ('qdrant' | 'ollama' | 'waystone')[];
    readonly networkName: string;
    readonly dataVolume: string;
    readonly qdrantVolume?: string;
    readonly nodeImage: string;
    readonly qdrantImage?: string;
    readonly ollamaImage?: string;
  };
  readonly paths: {
    readonly stateDirectory: string;
    readonly dataDirectory: string;
    readonly backupDirectory: string;
  };
  readonly authentication: {
    readonly mode: 'local-bearer-v1';
    readonly credentialId: string;
    readonly tokenFile: string;
  };
  readonly endpoints: {
    readonly ollama?: string;
    readonly qdrant?: string;
    readonly providerCredential?: SecretSelector;
    readonly vectorCredential?: SecretSelector;
  };
  readonly semantic?: SeedbedSemanticConfigurationV1;
  readonly migrations: {
    readonly diamond: string;
    readonly taproot: string;
    readonly workshop: string;
    readonly expectedCatalogDigest: string;
  };
  readonly backup: {
    readonly maxArchiveBytes: number;
    readonly maxBlobBytes: number;
    readonly retain: number;
  };
}

export interface OwnerLedgerEvidence {
  readonly namespace: string;
  readonly schemaVersion: string;
  readonly digest: string;
}

export interface OwnerDiagnostic {
  readonly owner: OwnerName;
  readonly packageVersion: string;
  readonly schemaVersion: string;
  readonly migrationDigest: string;
  readonly ready: boolean;
  readonly ledger: OwnerLedgerEvidence;
}

export interface MigrationStep {
  readonly owner: OwnerName;
  readonly expectedVersion: string;
  readonly packageSha256: string;
}

export interface InstallationPlan {
  readonly format: 'gnolith-seedbed-install-plan-v1';
  readonly operationId: string;
  readonly configDigest: string;
  readonly steps: readonly (
    | 'validate-inputs'
    | 'prepare-storage'
    | 'diamond-migrate'
    | 'taproot-migrate'
    | 'workshop-migrate'
    | 'workshop-bootstrap-v1'
    | 'workshop-semantic-configure-v1'
    | 'compose-up'
    | 'verify-owner-state'
    | 'write-receipt'
  )[];
  readonly migrations: readonly MigrationStep[];
}

export interface InstallationReceipt {
  readonly format: 'gnolith-seedbed-install-receipt-v1';
  readonly operationId: string;
  readonly configDigest: string;
  readonly endpoint: string;
  readonly expectedInstallationId: string;
  readonly expectedBaseIri: string;
  readonly packageVersions: Readonly<Record<OwnerName, string>>;
  readonly schemaVersions: Readonly<Record<OwnerName, string>>;
  readonly expectedCatalogDigest: string;
  readonly credentialId: string;
  readonly credentialDigest: string;
  readonly protectedTokenFile: string;
  readonly requiredEnvironmentSelector: 'GNOLITH_BEARER_TOKEN';
  readonly clientVerified: false;
  readonly semantic?: SemanticConfigurationReceiptV1;
}

export interface OperationIssue {
  readonly code: string;
  readonly owner?: OwnerName;
  readonly phase: string;
  readonly remediation: string;
}

export interface InstallationBackupManifest {
  readonly formatVersion: 1;
  readonly installationId: string;
  readonly baseIri: string;
  readonly createdAt: string;
  readonly packageVersions: Readonly<Record<string, string>>;
  readonly sections: readonly {
    readonly owner: string;
    readonly schemaVersion: string;
    readonly sha256: string;
    readonly disposition: 'retained' | 'rebuildable' | 'deferred';
  }[];
  readonly blobs: readonly { id: string; bytes: number; sha256: string }[];
}

export interface RetentionReport {
  readonly retained: readonly string[];
  readonly rebuildable: readonly string[];
  readonly deferred: readonly string[];
  readonly expired: readonly string[];
  readonly unsupported: readonly string[];
}

export interface LegacyLocalAdoptionManifestV1 {
  readonly format: 'gnolith-legacy-local-adoption-v1';
  readonly source: {
    readonly kind: 'database-and-blobs' | 'seedbed-snapshot';
    readonly databasePath?: string;
    readonly blobPath?: string;
    readonly snapshotPath?: string;
  };
  readonly expectedInstallationId: string;
  readonly expectedBaseIri: string;
  readonly expectedPackages: {
    readonly diamond: '0.4.1';
    readonly taproot: '0.4.2';
    readonly workshop: '0.4.2';
    readonly seedbed: '0.3.2';
  };
  readonly targetComposeProject: string;
}

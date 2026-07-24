import { lstat, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { InstallationPorts } from './owner-ports.js';
import { OWNER_LEDGER_NAMESPACES, OWNER_ORDER, type SeedbedConfig } from './types.js';
import type { ComposeDriver } from './migration.js';
import { configDigest } from './config.js';
import { sha256 } from './canonical.js';
import { inspectProtectedCredential } from './secrets.js';

export interface HostDiagnostics {
  dockerCli: { available: boolean; version?: string };
  dockerEngine: { available: boolean; version?: string };
  compose: { available: boolean; version?: string };
}

export interface DiagnosticHost {
  inspect(): Promise<HostDiagnostics>;
  reachable(endpoint: string): Promise<boolean>;
}

export interface DoctorReport {
  readonly format: 'gnolith-seedbed-doctor-v1';
  readonly configDigest: string;
  readonly host: HostDiagnostics;
  readonly compose: { healthy: boolean; project: string; endpoint: string };
  readonly artifacts: readonly { owner: string; exists: boolean; sha256: string; digestMatches: boolean }[];
  readonly credential: { selector: string; exists: boolean; protected: boolean };
  readonly owners: readonly {
    owner: string;
    ready: boolean;
    packageVersion?: string;
    schemaVersion?: string;
    migrationDigest?: string;
  }[];
  readonly optionalReachability: { qdrant?: boolean; ollama?: boolean };
  readonly backup: { directoryExists: boolean; retain: number; maxArchiveBytes: number };
  readonly mutationsPerformed: false;
  readonly issues: readonly { code: string; phase: string; remediation: string }[];
}

export async function diagnoseInstallation(input: {
  config: SeedbedConfig;
  ports: InstallationPorts;
  compose: ComposeDriver;
  host: DiagnosticHost;
  artifactRoot?: string;
}): Promise<DoctorReport> {
  const issues: { code: string; phase: string; remediation: string }[] = [];
  const host = await input.host.inspect().catch(() => ({
    dockerCli: { available: false },
    dockerEngine: { available: false },
    compose: { available: false },
  }));
  const healthy = await input.compose.health(input.config).then((value) => value.healthy).catch(() => false);
  if (!healthy) issues.push({ code: 'compose_unhealthy', phase: 'workshop', remediation: 'Resume the recorded Seedbed operation to restart the exact Compose project and revalidate authenticated readiness.' });
  const owners = [];
  for (const owner of OWNER_ORDER) {
    try {
      const diagnostic = await input.ports[owner].diagnose();
      owners.push({
        owner,
        ready: diagnostic.ready,
        packageVersion: diagnostic.packageVersion,
        schemaVersion: diagnostic.schemaVersion,
        migrationDigest: diagnostic.migrationDigest,
      });
      if (!diagnostic.ready) issues.push({ code: 'owner_not_ready', phase: owner, remediation: 'Run an explicit digest-bound migration plan/apply.' });
      if (
        diagnostic.packageVersion !== input.config.packages[owner].version
        || diagnostic.schemaVersion !== input.config.migrations[owner]
        || diagnostic.ledger.namespace !== OWNER_LEDGER_NAMESPACES[owner]
        || !/^[0-9a-f]{64}$/u.test(diagnostic.ledger.digest)
      ) issues.push({ code: 'owner_version_mismatch', phase: owner, remediation: 'Resume the exact component-lock-bound migration plan before starting Workshop.' });
    } catch {
      owners.push({ owner, ready: false });
      issues.push({ code: 'owner_diagnostic_unavailable', phase: owner, remediation: 'Inspect the owner-local diagnostic command and container logs.' });
    }
  }
  const artifacts = await Promise.all(OWNER_ORDER.map(async (owner) => {
    const path = resolve(input.artifactRoot ?? process.cwd(), input.config.packages[owner].artifact);
    try {
      const metadata = await lstat(path);
      const exists = metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= input.config.backup.maxArchiveBytes;
      const digestMatches = exists && sha256(await readFile(path)) === input.config.packages[owner].sha256;
      if (!digestMatches) issues.push({ code: 'artifact_digest_mismatch', phase: owner, remediation: 'Restore the exact component-lock-pinned artifact before apply.' });
      return { owner, exists, sha256: input.config.packages[owner].sha256, digestMatches };
    } catch {
      issues.push({ code: 'artifact_unavailable', phase: owner, remediation: 'Restore the exact component-lock-pinned artifact before apply.' });
      return { owner, exists: false, sha256: input.config.packages[owner].sha256, digestMatches: false };
    }
  }));
  const credentialInspection = await inspectProtectedCredential(input.config.authentication.tokenFile)
    .then(() => ({ exists: true, protected: true }))
    .catch(async () => ({
      exists: await stat(input.config.authentication.tokenFile).then((value) => value.isFile()).catch(() => false),
      protected: false,
    }));
  if (!credentialInspection.protected) issues.push({ code: 'credential_selector_unprotected', phase: 'credential', remediation: 'Repair the protected local bearer selector before starting Workshop.' });
  const backupExists = await stat(input.config.paths.backupDirectory).then((value) => value.isDirectory()).catch(() => false);
  if (issues.length > 100) issues.length = 100;
  return {
    format: 'gnolith-seedbed-doctor-v1',
    configDigest: configDigest(input.config),
    host,
    compose: {
      healthy,
      project: input.config.compose.projectName,
      endpoint: `http://127.0.0.1:${input.config.compose.workshopPort}/mcp`,
    },
    artifacts,
    credential: { selector: input.config.authentication.tokenFile, ...credentialInspection },
    owners,
    optionalReachability: {
      ...(input.config.endpoints.qdrant === undefined ? {} : { qdrant: await input.host.reachable(input.config.endpoints.qdrant).catch(() => false) }),
      ...(input.config.endpoints.ollama === undefined ? {} : { ollama: await input.host.reachable(input.config.endpoints.ollama).catch(() => false) }),
    },
    backup: {
      directoryExists: backupExists,
      retain: input.config.backup.retain,
      maxArchiveBytes: input.config.backup.maxArchiveBytes,
    },
    mutationsPerformed: false,
    issues,
  };
}

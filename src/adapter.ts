import { open, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { D1DatabaseLike } from '@gnolith/diamond';
import { NodeSqliteDatabase } from '@gnolith/diamond/node-sqlite';
import type { SeedbedConfig } from './config.js';
import { ExitCode, SeedbedError } from './errors.js';

/**
 * Host-owned bindings intentionally kept outside Diamond, Taproot, and
 * Workshop. A generated Site can provide D1 and hosted implementations of
 * these ports without teaching any package about local files or provisioning.
 */
export interface InstallationHostBindings<Database extends D1DatabaseLike = D1DatabaseLike> {
  readonly kind: string;
  readonly database: Database;
  readonly blobs?: BlobBinding;
  readonly embeddings?: EmbeddingProviderBinding;
  readonly vectors?: VectorIndexBinding;
  readonly clock?: ClockBinding;
  readonly background?: BackgroundExecutionBinding;
  readonly http?: HttpBinding;
  readonly credentials?: CredentialBinding;
}

export interface BlobBinding {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface EmbeddingProviderBinding {
  readonly providerId: string;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]>;
}

export interface VectorIndexBinding {
  readonly indexId: string;
  readonly dimension: number;
  readonly metric: string;
}

export interface ClockBinding { now(): Date }
export interface BackgroundExecutionBinding { wake(): void }
export interface HttpBinding { fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> }
export interface CredentialBinding { read(handle: string): Promise<Uint8Array> }

export interface NativeInstallationAdapter {
  readonly kind: 'native-sqlite';
  readonly databasePath: string;
  readonly blobPath: string;
  exists(): Promise<boolean>;
  open(): Promise<NodeSqliteDatabase>;
  /** Serialize destructive local maintenance such as restore. */
  withMaintenanceLock<T>(operation: () => Promise<T>): Promise<T>;
}

export function createNativeInstallationAdapter(config: SeedbedConfig): NativeInstallationAdapter {
  const databasePath = resolve(config.databasePath);
  const blobPath = resolve(config.blobPath ?? join(dirname(databasePath), 'blobs'));
  const lockPath = `${databasePath}.maintenance.lock`;
  return Object.freeze({
    kind: 'native-sqlite' as const,
    databasePath,
    blobPath,
    async exists() {
      try {
        return (await stat(databasePath)).isFile();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
    async open() {
      await mkdir(dirname(databasePath), { recursive: true });
      return new NodeSqliteDatabase(databasePath, { busyTimeoutMs: config.busyTimeoutMs ?? 5_000 });
    },
    async withMaintenanceLock<T>(operation: () => Promise<T>): Promise<T> {
      await mkdir(dirname(lockPath), { recursive: true });
      let handle;
      try {
        handle = await open(lockPath, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new SeedbedError(
            'Installation maintenance is already active',
            ExitCode.persistence,
            'maintenance_busy',
          );
        }
        throw error;
      }
      try {
        return await operation();
      } finally {
        await handle.close();
        await rm(lockPath, { force: true });
      }
    },
  });
}

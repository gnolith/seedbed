export class ReadOnlyPortableSql {
  constructor(path: string, options?: { timeoutMs?: number });
  prepare(sql: string): ReadOnlyPortableStatement;
  batch<T = Record<string, unknown>>(statements: readonly ReadOnlyPortableStatement[]): Promise<readonly ReadOnlyPortableResult<T>[]>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface ReadOnlyPortableStatement {
  bind(...values: readonly unknown[]): ReadOnlyPortableStatement;
  all<T = Record<string, unknown>>(): Promise<ReadOnlyPortableResult<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface ReadOnlyPortableResult<T> {
  readonly results: readonly T[];
  readonly success: true;
  readonly meta: { readonly changes: 0; readonly rows_read: number };
}

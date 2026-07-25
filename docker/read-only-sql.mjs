import { DatabaseSync } from 'node:sqlite';

const MAX_SQL_BYTES = 256 * 1024;
const MAX_BIND_VALUES = 10_000;

export class ReadOnlyPortableSql {
  #connection;
  #closed = false;
  #tail = Promise.resolve();

  constructor(path, options = {}) {
    if (typeof path !== 'string' || path.length === 0 || path === ':memory:') {
      throw new TypeError('A file-backed SQLite source path is required');
    }
    const timeout = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60_000) {
      throw new RangeError('Read-only SQLite timeout must be between 0 and 60000 milliseconds');
    }
    this.#connection = new DatabaseSync(path, {
      readOnly: true,
      allowExtension: false,
      enableForeignKeyConstraints: true,
      timeout,
    });
    try {
      this.#connection.exec('PRAGMA query_only = ON');
      this.#connection.exec(`PRAGMA busy_timeout = ${timeout}`);
    } catch (error) {
      this.#connection.close();
      this.#closed = true;
      throw error;
    }
  }

  prepare(sql) {
    this.#assertOpen();
    if (typeof sql !== 'string' || sql.trim().length === 0 || Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) {
      throw new TypeError('Prepared SQL is empty or exceeds the read-only bound');
    }
    return new ReadOnlyStatement(this, sql);
  }

  async batch(statements) {
    if (!Array.isArray(statements) || statements.length > MAX_BIND_VALUES) {
      throw new TypeError('Read-only SQLite batch exceeds the statement bound');
    }
    return this.withConnection((connection) => statements.map((statement) => {
      if (!(statement instanceof ReadOnlyStatement) || statement.owner !== this) {
        throw new TypeError('Read-only SQLite batch received an incompatible statement');
      }
      return statement.execute(connection);
    }));
  }

  async close() {
    await this.#serialize(() => {
      if (!this.#closed) {
        this.#connection.close();
        this.#closed = true;
      }
    });
  }

  async [Symbol.asyncDispose]() {
    await this.close();
  }

  withConnection(operation) {
    return this.#serialize(() => {
      this.#assertOpen();
      return operation(this.#connection);
    });
  }

  async #serialize(operation) {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }

  #assertOpen() {
    if (this.#closed || !this.#connection.isOpen) throw new Error('Read-only SQLite source is closed');
  }
}

class ReadOnlyStatement {
  constructor(owner, sql, values = []) {
    this.owner = owner;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    if (values.length > MAX_BIND_VALUES) throw new TypeError('Read-only SQLite bindings exceed the value bound');
    return new ReadOnlyStatement(this.owner, this.sql, values.map(normalizeInput));
  }

  async all() {
    return this.owner.withConnection((connection) => this.execute(connection));
  }

  async first() {
    const result = await this.all();
    return result.results[0] ?? null;
  }

  execute(connection) {
    const statement = connection.prepare(this.sql);
    statement.setReadBigInts(true);
    const results = statement.all(...this.values).map(normalizeRow);
    return { results, success: true, meta: { changes: 0, rows_read: results.length } };
  }
}

function normalizeInput(value) {
  if (value === null || typeof value === 'string' || typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new RangeError('SQLite integer bindings must be safe numbers or bigint values');
    }
    return value;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  throw new TypeError(`Unsupported SQLite binding value: ${typeof value}`);
}

function normalizeRow(row) {
  for (const key of Object.keys(row)) {
    if (typeof row[key] === 'bigint') row[key] = normalizeInteger(row[key]);
  }
  return row;
}

function normalizeInteger(value) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(value)
    : value;
}

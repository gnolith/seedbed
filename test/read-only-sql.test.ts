import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReadOnlyPortableSql } from '../docker/read-only-sql.mjs';

describe('read-only portable SQL capability', () => {
  it('supports bounded structural reads while refusing source mutation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seedbed-read-only-'));
    const databasePath = join(directory, 'legacy.sqlite');
    const writer = new DatabaseSync(databasePath);
    writer.exec('CREATE TABLE owner_state(id TEXT PRIMARY KEY, value BLOB) STRICT');
    writer.prepare('INSERT INTO owner_state(id, value) VALUES (?, ?)').run('one', new Uint8Array([1, 2, 3]));
    writer.close();
    const before = await readFile(databasePath);
    const beforeSize = (await stat(databasePath)).size;

    await using source = new ReadOnlyPortableSql(databasePath, { timeoutMs: 100 });
    await expect(source.prepare('SELECT id, value FROM owner_state WHERE id = ?').bind('one').first())
      .resolves.toMatchObject({ id: 'one', value: new Uint8Array([1, 2, 3]) });
    await expect(source.prepare('UPDATE owner_state SET id = ?').bind('two').all())
      .rejects.toThrow(/readonly|read-only|attempt to write/u);
    await expect(source.batch([source.prepare('SELECT count(*) AS total FROM owner_state')]))
      .resolves.toMatchObject([{ results: [{ total: 1 }] }]);

    expect(await readFile(databasePath)).toEqual(before);
    expect((await stat(databasePath)).size).toBe(beforeSize);
    await expect(stat(`${databasePath}-wal`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(`${databasePath}-shm`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(`${databasePath}-journal`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects memory databases, excessive SQL, and unsafe bindings', async () => {
    expect(() => new ReadOnlyPortableSql(':memory:')).toThrow(/file-backed/u);
    const directory = await mkdtemp(join(tmpdir(), 'seedbed-read-only-'));
    const databasePath = join(directory, 'legacy.sqlite');
    const writer = new DatabaseSync(databasePath);
    writer.close();
    await using source = new ReadOnlyPortableSql(databasePath);
    expect(() => source.prepare('x'.repeat(256 * 1024 + 1))).toThrow(/exceeds/u);
    expect(() => source.prepare('SELECT ?').bind(Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe/u);
  });
});

import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalJson } from './canonical.js';

export interface OperationLock {
  release(): Promise<void>;
}

export async function acquireOperationLock(path: string, operationId: string): Promise<OperationLock> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const record = { format: 'gnolith-seedbed-operation-lock-v1', operationId, pid: process.pid };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(`${canonicalJson(record)}\n`);
      await handle.sync();
      return {
        async release() {
          await handle.close();
          const current = await readFile(path, 'utf8').catch(() => '');
          if (current === `${canonicalJson(record)}\n`) await rm(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readExisting(path);
      if (existing && isAlive(existing.pid)) throw new TypeError(`Installation operation ${existing.operationId} is already active`);
      await rm(path, { force: true });
    }
  }
  throw new TypeError('Could not acquire the installation operation lock');
}

async function readExisting(path: string): Promise<{ pid: number; operationId: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown; operationId?: unknown };
    if (Number.isSafeInteger(value.pid) && typeof value.operationId === 'string') return { pid: value.pid as number, operationId: value.operationId };
  } catch {
    // Invalid or partially written lock state is stale because creation writes through an open exclusive descriptor.
  }
  return undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

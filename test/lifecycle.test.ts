import { describe, expect, it, vi } from 'vitest';
import { OperationLifecycle } from '../src/lifecycle.js';

describe('OperationLifecycle', () => {
  it('drains in-flight operations and rejects new work', async () => {
    const lifecycle = new OperationLifecycle();
    let release!: () => void;
    const work = lifecycle.run(() => new Promise<void>((resolve) => { release = resolve; }));
    const drained = lifecycle.drain(1_000);
    expect(lifecycle.accepting).toBe(false);
    expect(() => lifecycle.run(async () => undefined)).toThrow(/shutting down/u);
    release();
    await expect(Promise.all([work, drained])).resolves.toBeDefined();
  });

  it('fails deterministically when drain times out', async () => {
    vi.useFakeTimers();
    const lifecycle = new OperationLifecycle();
    void lifecycle.run(() => new Promise<void>(() => undefined));
    const drained = lifecycle.drain(100);
    const expectation = expect(drained).rejects.toMatchObject({ code: 'drain_timeout' });
    await vi.advanceTimersByTimeAsync(101);
    await expectation;
    vi.useRealTimers();
  });
});

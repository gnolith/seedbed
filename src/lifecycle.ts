import { ExitCode, SeedbedError } from './errors.js';

export class OperationLifecycle {
  #accepting = true;
  #inFlight = new Set<Promise<unknown>>();

  get accepting(): boolean {
    return this.#accepting;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#accepting) {
      throw new SeedbedError('Seedbed is shutting down', ExitCode.operation, 'shutting_down');
    }
    const pending = operation();
    this.#inFlight.add(pending);
    void pending.then(
      () => this.#inFlight.delete(pending),
      () => this.#inFlight.delete(pending),
    );
    return pending;
  }

  async drain(timeoutMs: number): Promise<void> {
    this.#accepting = false;
    if (this.#inFlight.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.#inFlight]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new SeedbedError('Shutdown drain timed out', ExitCode.operation, 'drain_timeout')), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

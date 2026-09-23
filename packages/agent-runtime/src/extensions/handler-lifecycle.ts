import { AsyncLocalStorage } from "node:async_hooks";

/** Owns waits, not arbitrary JavaScript or external side effects of trusted code. */
export class HandlerLifecycle {
  private controller = new AbortController();
  private readonly operations = new AsyncLocalStorage<{ signal: AbortSignal; cancel: () => void }>();

  get operationSignal(): AbortSignal {
    return this.operations.getStore()?.signal ?? this.signal;
  }

  cancelOperation(): void {
    this.operations.getStore()?.cancel();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(): void {
    const previous = this.controller;
    this.controller = new AbortController();
    previous.abort();
  }

  async run<T>(work: () => T | PromiseLike<T>, signal: AbortSignal, timeoutMs?: number): Promise<T> {
    signal.throwIfAborted();
    const owner = new AbortController();
    const operation = AbortSignal.any([signal, owner.signal]);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        operation.removeEventListener("abort", abort);
        owner.abort();
        settle();
      };
      const abort = () => finish(() => reject(operation.reason));
      const timer = timeoutMs === undefined ? undefined : setTimeout(
        () => finish(() => reject(new Error(`handler exceeded ${timeoutMs}ms`))),
        timeoutMs,
      );
      operation.addEventListener("abort", abort, { once: true });
      try {
        Promise.resolve(this.operations.run({ signal: operation, cancel: () => owner.abort() }, work)).then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(error)),
        );
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }
}

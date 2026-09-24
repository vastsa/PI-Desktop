/** Owns cancellation for MCP calls without closing a server shared by sessions. */
export class McpCallRegistry {
  private readonly calls = new Map<string, Set<AbortController>>();

  async run<T>(
    sessionId: string | null | undefined,
    invoke: (signal: AbortSignal | undefined) => Promise<T>,
    parentSignal?: AbortSignal,
  ): Promise<T> {
    if (!sessionId && !parentSignal) return invoke(undefined);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parentSignal?.aborted) abort();
    else parentSignal?.addEventListener("abort", abort, { once: true });
    if (sessionId) {
      let active = this.calls.get(sessionId);
      if (!active) {
        active = new Set();
        this.calls.set(sessionId, active);
      }
      active.add(controller);
    }
    try {
      return await invoke(controller.signal);
    } finally {
      parentSignal?.removeEventListener("abort", abort);
      if (sessionId) {
        const active = this.calls.get(sessionId);
        active?.delete(controller);
        if (active?.size === 0) this.calls.delete(sessionId);
      }
    }
  }

  cancelSession(sessionId: string): void {
    for (const controller of this.calls.get(sessionId) ?? []) controller.abort();
  }

  cancelAll(): void {
    for (const sessionId of this.calls.keys()) this.cancelSession(sessionId);
  }
}

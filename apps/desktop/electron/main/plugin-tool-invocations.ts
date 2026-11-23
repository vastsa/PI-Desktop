import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type PluginToolInvocation = {
  readonly id: string;
  readonly pluginId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly turnId?: string;
  /** Runtime tool call this invocation answers; the parent of any delegation
   * the plugin starts (`agent.subagent`). Taken from the broker dispatch,
   * never from plugin arguments. */
  readonly toolCallId?: string;
  readonly signal: AbortSignal;
};

type ActiveInvocation = PluginToolInvocation & {
  owner: object;
  controller: AbortController;
  detach: () => void;
};

const invocationError = (message: string) => Object.assign(new Error(message), {
  code: "PLUGIN_TOOL_ABORTED",
});

/** Correlate tool RPCs without letting parallel sessions share ambient state. */
export class PluginToolInvocations {
  private readonly active = new Map<string, ActiveInvocation>();
  private readonly context = new AsyncLocalStorage<ActiveInvocation | undefined>();

  begin(
    owner: object,
    input: Omit<PluginToolInvocation, "id" | "signal"> & { signal?: AbortSignal },
  ): PluginToolInvocation {
    const controller = new AbortController();
    const invocation: ActiveInvocation = {
      id: randomUUID(),
      pluginId: input.pluginId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      signal: controller.signal,
      owner,
      controller,
      detach: () => input.signal?.removeEventListener("abort", abort),
    };
    const abort = () => this.cancel(invocation, input.signal?.reason ?? invocationError("Tool execution aborted"));
    this.active.set(invocation.id, invocation);
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener("abort", abort, { once: true });
    return invocation;
  }

  current(owner: object): PluginToolInvocation | undefined {
    const invocation = this.context.getStore();
    if (!invocation) return undefined;
    this.assertActive(owner, invocation);
    return invocation;
  }

  withoutContext<T>(operation: () => T): T {
    return this.context.run(undefined, operation);
  }

  async run<T>(owner: object, id: unknown, operation: () => Promise<T>): Promise<T> {
    if (id === undefined) return this.withoutContext(operation);
    const invocation = typeof id === "string" ? this.active.get(id) : undefined;
    if (!invocation) throw invocationError("Unknown or expired plugin tool invocation");
    this.assertActive(owner, invocation);
    return this.context.run(invocation, () => new Promise<T>((resolve, reject) => {
      const abort = () => reject(invocation.signal.reason ?? invocationError("Tool execution aborted"));
      invocation.signal.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(() => {
        this.assertActive(owner, invocation);
        return operation();
      }).then(resolve, reject).finally(() => {
        invocation.signal.removeEventListener("abort", abort);
      });
    }));
  }

  finish(invocation: PluginToolInvocation): void {
    this.cancel(invocation, invocationError("Plugin tool invocation finished"));
  }

  cancel(invocation: PluginToolInvocation, reason: unknown): void {
    const active = this.active.get(invocation.id);
    if (!active) return;
    this.active.delete(active.id);
    active.detach();
    active.controller.abort(reason);
  }

  cancelSession(sessionId: string, reason: string): void {
    for (const invocation of this.active.values()) {
      if (invocation.sessionId === sessionId) this.cancel(invocation, invocationError(reason));
    }
  }

  cancelOwner(owner: object, reason: string): void {
    for (const invocation of this.active.values()) {
      if (invocation.owner === owner) this.cancel(invocation, invocationError(reason));
    }
  }

  private assertActive(owner: object, invocation: ActiveInvocation): void {
    invocation.signal.throwIfAborted();
    if (invocation.owner !== owner || this.active.get(invocation.id) !== invocation) {
      throw invocationError("Plugin tool invocation does not belong to this host process");
    }
  }
}

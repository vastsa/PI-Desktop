import {
  PLUGIN_INFERENCE_LIMITS as limits, inferenceJsonBytes, inferenceObject,
  validateProviderChatEvent, validateProviderImageResult, validateProviderInferenceRequest,
  type PluginProviderAdaptersV1, type PluginProviderAdapterDeclarationV1,
  type PluginProviderChatEventV1, type PluginProviderChatRequestV1,
  type PluginProviderImageRequestV1, type PluginProviderInferenceContextV1,
} from "./provider-adapter.js";

type Invocation = {
  controller: AbortController;
  iterator?: AsyncIterator<PluginProviderChatEventV1>;
  busy: boolean;
  bytes: number;
  events: number;
  terminal: boolean;
  timer: ReturnType<typeof setTimeout>;
};
/** Utility-process owner of pull iterators. No tool executor or filesystem interface. */
export class PluginProviderInferenceHost {
  private calls = new Map<string, Invocation>();
  constructor(
    private adapters: PluginProviderAdaptersV1,
    private declarations: ReadonlyArray<{ id: string; adapter?: PluginProviderAdapterDeclarationV1 }>,
    private reportError: (error: unknown) => void,
  ) {
    for (const declaration of declarations) {
      if (!declaration.adapter) continue;
      const adapter = adapters[declaration.id];
      if (adapter?.version !== 1 || ["chat", "images"].some(operation =>
        declaration.adapter?.[operation as "chat" | "images"] === true
        && typeof adapter[operation as "chat" | "images"] !== "function")) {
        throw new Error("Declared provider adapters require matching version 1 module exports");
      }
    }
  }
  private begin(id: string, request: unknown, operation: "chat" | "images") {
    validateProviderInferenceRequest(request, operation);
    const r = inferenceObject(request);
    const declaration = this.declarations.find(d => d.id === r.providerId);
    if (!declaration?.adapter?.[operation]) throw new Error("Provider inference operation not declared");
    const adapter = this.adapters[declaration.id];
    if (!id || this.calls.has(id) || this.calls.size >= limits.capacity || adapter?.version !== 1) {
      throw new Error("Provider inference capacity or invocation identity rejected");
    }
    const state: Invocation = {
      controller: new AbortController(), busy: false, bytes: 0, events: 0, terminal: false,
      timer: setTimeout(() => this.close(id), limits.lifetimeMs),
    };
    this.calls.set(id, state);
    return { state, adapter };
  }
  private async wait<T>(state: Invocation, promise: PromiseLike<T>): Promise<T> {
    const signal = state.controller.signal;
    signal.throwIfAborted();
    let abort: () => void = () => undefined;
    const timer = setTimeout(() => state.controller.abort(new Error("Provider inference timeout")), limits.callTimeoutMs);
    try {
      const result = await Promise.race([promise, new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      })]);
      signal.throwIfAborted();
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  async open(id: string, request: PluginProviderChatRequestV1, credential?: PluginProviderInferenceContextV1["credential"]) {
    const { state, adapter } = this.begin(id, request, "chat");
    try {
      await this.wait(state, Promise.resolve(adapter.chat!(request, { signal: state.controller.signal, credential })).then(iterable => {
        const iterator = iterable[Symbol.asyncIterator]();
        // A cancelled factory can still resolve; release its iterator without resurrecting the call.
        if (state.controller.signal.aborted) {
          this.returnIterator(iterator);
          state.controller.signal.throwIfAborted();
        }
        state.iterator = iterator;
      }));
      state.controller.signal.throwIfAborted();
      return { opened: true };
    } catch (error) { this.close(id); throw error; }
  }
  async next(id: string) {
    const state = this.calls.get(id);
    if (!state?.iterator || state.busy || state.terminal) throw new Error("Provider inference iterator unavailable");
    state.busy = true;
    try {
      const event = await this.wait(state, state.iterator.next());
      if (this.calls.get(id) !== state) throw new Error("Provider inference invocation closed");
      if (event.done) throw new Error("Provider inference ended without completion");
      validateProviderChatEvent(event.value);
      state.bytes += inferenceJsonBytes(event.value, limits.eventBytes);
      if (++state.events > limits.events || state.bytes > limits.totalBytes) throw new Error("Provider inference stream limit exceeded");
      state.terminal = event.value.type === "done" || event.value.type === "error";
      return event.value;
    } catch (error) { this.close(id); throw error; }
    finally { state.busy = false; }
  }
  async images(id: string, request: PluginProviderImageRequestV1, credential?: PluginProviderInferenceContextV1["credential"]) {
    const { state, adapter } = this.begin(id, request, "images");
    try {
      const result = await this.wait(state, adapter.images!(request, { signal: state.controller.signal, credential }));
      if (this.calls.get(id) !== state) throw new Error("Provider inference invocation closed");
      validateProviderImageResult(result);
      return result;
    } finally { this.close(id); }
  }
  close(id: string) {
    const state = this.calls.get(id);
    if (!state) return;
    this.calls.delete(id);
    clearTimeout(state.timer);
    // Abort before return(): a generator may be suspended in an awaited next().
    state.controller.abort(new Error("Provider inference invocation closed"));
    if (state.iterator) this.returnIterator(state.iterator);
  }
  private returnIterator(iterator: AsyncIterator<PluginProviderChatEventV1>) {
    if (!iterator.return) return;
    try { void Promise.resolve(iterator.return()).catch(this.reportError); }
    catch (error) { this.reportError(error); }
  }
  dispose() { for (const id of this.calls.keys()) this.close(id); }
}

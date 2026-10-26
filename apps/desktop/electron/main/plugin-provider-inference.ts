import { randomUUID } from "node:crypto";
import {
  PLUGIN_INFERENCE_LIMITS as limits, inferenceObject, inferenceJsonBytes,
  validateProviderChatEvent, validateProviderImageResult, validateProviderInferenceRequest,
  type PluginProviderInferenceBindingV1, type PluginProviderInferenceContextV1,
} from "@pi-desktop/plugin-sdk";
import type { ProviderImages, ModelAuth } from "@earendil-works/pi-ai";
import type { PluginRuntime } from "./plugin-runtime";
import type { PluginProviderSourceRow } from "./plugin-provider-source";

type Bound = { providerId: string; modelId: string; adapter: PluginProviderInferenceBindingV1 };
type Invocation = {
  sessionId: string; bound: Bound; controller: AbortController; opening: Promise<unknown>;
  bytes: number; events: number; busy: boolean; terminal: boolean; timer: ReturnType<typeof setTimeout>;
  unsubscribeRuntime: () => void;
};
type BrokerOptions = {
  plugins: Pick<PluginRuntime, "invokeProviderInference" | "providerInferenceBinding" | "providerInferenceSignal">;
  credential: (providerId: string) => Promise<PluginProviderInferenceContextV1["credential"]>;
  reportError: (error: unknown) => void;
};
/** Host-owned session/model authorization is passed by AgentSidecar, never accepted from a plugin. */
export class PluginProviderInferenceBroker {
  private calls = new Map<string, Invocation>();
  private imageCalls = new Map<string, { providerId: string; abort: () => void }>();
  private options: BrokerOptions;
  constructor(options: BrokerOptions) { this.options = options; }
  private binding(value: unknown): Bound {
    const b = inferenceObject(value);
    const adapter = inferenceObject(b.adapter);
    if (typeof b.providerId !== "string" || typeof b.modelId !== "string" || adapter.version !== 1
      || typeof adapter.pluginId !== "string" || typeof adapter.contributionId !== "string" || typeof adapter.runtimeId !== "string"
      || (adapter.accountId !== undefined ? b.providerId !== adapter.accountId
        : b.providerId !== `plugin:${adapter.pluginId}:${adapter.contributionId}`)) throw new Error("Invalid inference binding");
    return value as Bound;
  }
  private async credential(providerId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    let abort: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.options.credential(providerId), new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(new Error("Provider inference credential timeout")), limits.callTimeoutMs);
      })]);
    } finally {
      signal.removeEventListener("abort", abort);
      if (timer) clearTimeout(timer);
    }
  }
  private async invoke(state: Invocation, id: string, operation: "open" | "next" | "images", request?: unknown) {
    const credential = operation === "open" || operation === "images"
      ? await this.credential(state.bound.providerId, state.controller.signal) : undefined;
    state.controller.signal.throwIfAborted();
    return this.options.plugins.invokeProviderInference(state.bound.adapter, operation, {
      invocationId: id,
      ...(request === undefined ? {} : { request }),
      ...(credential === undefined ? {} : { credential }),
    }, state.controller.signal);
  }
  async call(params: Record<string, unknown>, authorizedBinding: unknown): Promise<unknown> {
    const bound = this.binding(authorizedBinding);
    const sessionId = String(params.sessionId ?? "");
    if (params.operation === "open") {
      validateProviderInferenceRequest(params.request, "chat");
      const request = inferenceObject(params.request);
      if (request.modelId !== bound.modelId || request.providerId !== bound.adapter.contributionId || !bound.adapter.chat) throw new Error("Inference request binding mismatch");
      if (this.calls.size >= limits.capacity) throw new Error("Provider inference capacity exceeded");
      const id = randomUUID();
      const runtimeSignal = this.options.plugins.providerInferenceSignal(bound.adapter);
      runtimeSignal.throwIfAborted();
      const onRuntimeClosed = () => this.close(id);
      const state: Invocation = {
        sessionId, bound, controller: new AbortController(), opening: Promise.resolve(),
        bytes: 0, events: 0, busy: false, terminal: false,
        timer: setTimeout(() => this.close(id), limits.lifetimeMs),
        unsubscribeRuntime: () => runtimeSignal.removeEventListener("abort", onRuntimeClosed),
      };
      this.calls.set(id, state);
      runtimeSignal.addEventListener("abort", onRuntimeClosed, { once: true });
      state.opening = this.invoke(state, id, "open", params.request);
      // The first pull observes the failure; mark the promise handled while the caller is between pulls.
      void state.opening.catch(this.options.reportError);
      return { invocationId: id };
    }
    const id = String(params.invocationId ?? "");
    const state = this.calls.get(id);
    if (!state && params.operation === "close") return { closed: true };
    if (!state || state.sessionId !== sessionId || state.bound.providerId !== bound.providerId
      || state.bound.modelId !== bound.modelId || state.bound.adapter.runtimeId !== bound.adapter.runtimeId) throw new Error("Provider inference invocation not bound");
    if (params.operation === "close") { this.close(id); return { closed: true }; }
    if (params.operation !== "next" || state.busy || state.terminal) throw new Error("Invalid inference pull");
    state.busy = true;
    try {
      await state.opening;
      const event = await this.invoke(state, id, "next");
      if (this.calls.get(id) !== state) throw new Error("Provider inference invocation closed");
      validateProviderChatEvent(event);
      state.bytes += inferenceJsonBytes(event, limits.eventBytes);
      if (++state.events > limits.events || state.bytes > limits.totalBytes) throw new Error("Provider inference stream limit exceeded");
      state.terminal = event.type === "done" || event.type === "error";
      return event;
    } catch (error) { this.close(id); throw error; }
    finally { state.busy = false; }
  }
  private close(id: string) {
    const state = this.calls.get(id);
    if (!state) return;
    this.calls.delete(id);
    clearTimeout(state.timer);
    state.unsubscribeRuntime();
    state.controller.abort();
    void this.options.plugins.invokeProviderInference(state.bound.adapter, "close", { invocationId: id })
      .catch(this.options.reportError);
  }
  clear(sessionId?: string) {
    for (const [id, state] of this.calls) if (!sessionId || state.sessionId === sessionId) this.close(id);
    if (!sessionId) for (const call of this.imageCalls.values()) call.abort();
  }
  invalidateProvider(providerId: string) {
    for (const [id, state] of this.calls) if (state.bound.providerId === providerId) this.close(id);
    for (const call of this.imageCalls.values()) if (call.providerId === providerId) call.abort();
  }
  images(row: PluginProviderSourceRow, modelId: string): ProviderImages | undefined {
    const adapter = this.options.plugins.providerInferenceBinding(row, "images", modelId);
    if (!adapter) return undefined;
    return { generateImages: async (model, context, options) => {
      const id = randomUUID();
      const controller = new AbortController();
      const runtimeSignal = this.options.plugins.providerInferenceSignal(adapter);
      runtimeSignal.throwIfAborted();
      const abort = () => {
        if (controller.signal.aborted) return;
        controller.abort();
        void this.options.plugins.invokeProviderInference(adapter, "close", { invocationId: id }).catch(this.options.reportError);
      };
      options?.signal?.throwIfAborted();
      this.imageCalls.set(id, { providerId: row.id, abort });
      options?.signal?.addEventListener("abort", abort, { once: true });
      runtimeSignal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, limits.callTimeoutMs);
      try {
        const request = { version: 1, providerId: adapter.contributionId, modelId, input: context.input };
        validateProviderInferenceRequest(request, "images");
        const credential = await this.credential(row.id, controller.signal);
        controller.signal.throwIfAborted();
        const result = await this.options.plugins.invokeProviderInference(adapter, "images", { invocationId: id, request,
          ...(credential === undefined ? {} : { credential }) }, controller.signal);
        controller.signal.throwIfAborted();
        validateProviderImageResult(result);
        return { api: model.api, provider: model.provider, model: model.id, output: result.images,
          stopReason: "stop", timestamp: Date.now() };
      } finally {
        this.imageCalls.delete(id);
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
        runtimeSignal.removeEventListener("abort", abort);
      }
    } };
  }
}

/** Convert only request credentials; never accept refresh tokens or arbitrary secret references. */
export function inferenceCredential(auth: ModelAuth): PluginProviderInferenceContextV1["credential"] {
  const headers = Object.fromEntries(Object.entries(auth.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return { ...(auth.apiKey ? { apiKey: auth.apiKey } : {}), ...(Object.keys(headers).length ? { headers } : {}) };
}

import { EXTENSION_IMAGE_TIMEOUT_MS, parseExtensionImageRequest, type ExtensionImageOptions } from "./image-contract.js";
import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, AssistantImages, ImagesContext, Context, Model, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { RuntimeHost } from "../host-client.js";
import { EXTENSION_COMPLETE_TIMEOUT_MS, extensionModelError, parseExtensionCompleteRequest,
  type ExtensionCompleteOptions } from "./model-complete-contract.js";

/** Owns all one-shot requests made by one session runtime. */
export class ExtensionModelCompletions {
  private pending = new Set<AbortController>();
  private disposed = false;
  constructor(private host: RuntimeHost, private sessionId: string,
    private localModel?: (model: Pick<Model<Api>, "provider" | "id">) => {
      model: Model<Api>;
      stream: (model: Model<Api>, context: Context, options: ExtensionCompleteOptions) => AssistantMessageEventStream;
    } | undefined) {}

  async complete(extensionId: string, model: Pick<Model<Api>, "provider" | "id">,
    context: Context, options: ExtensionCompleteOptions = {}): Promise<AssistantMessage> {
    const { signal, ...wireOptions } = options;
    const request = parseExtensionCompleteRequest({ sessionId: this.sessionId, extensionId,
      requestId: randomUUID(), providerId: model?.provider, modelId: model?.id, context, options: wireOptions });
    const local = this.localModel?.(model);
    return this.send<AssistantMessage>("extensions.model.complete", request,
      options.timeoutMs ?? EXTENSION_COMPLETE_TIMEOUT_MS, signal,
      local ? (signal) => local.stream(local.model, context, { ...wireOptions, signal }).result() : undefined);
  }

  async generateImages(extensionId: string, model: { provider: string; id: string }, context: ImagesContext,
    options: ExtensionImageOptions = {}): Promise<AssistantImages> {
    const { signal, ...wireOptions } = options;
    const request = parseExtensionImageRequest({ sessionId: this.sessionId, extensionId,
      requestId: randomUUID(), providerId: model?.provider, modelId: model?.id, context, options: wireOptions });
    return this.send("extensions.model.generateImages", request,
      options.timeoutMs ?? EXTENSION_IMAGE_TIMEOUT_MS, signal);
  }

  private async send<T>(method: string, request: { sessionId: string; extensionId: string; requestId: string },
    timeoutMs: number, signal?: AbortSignal, local?: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposed) throw extensionModelError("TURN_ABORTED", "Extension runtime was disposed");
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw extensionModelError("INVALID_ARGUMENT", "signal must be an AbortSignal");
    if (signal?.aborted) throw extensionModelError("TURN_ABORTED", "Completion was aborted");
    const controller = new AbortController();
    this.pending.add(controller);
    let timedOut = false;
    const forwardAbort = () => controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let rejectAbort: (error: Error) => void = () => {};
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const cancel = () => {
      rejectAbort(extensionModelError(timedOut ? "TIMEOUT" : "TURN_ABORTED", timedOut ? "Completion timed out" : "Completion was aborted"));
      // Cancellation uses a separate reverse RPC so the host can interrupt an
      // outstanding provider call. Transport failures also settle the main call.
      if (!local) void this.host.call("extensions.model.cancel", { sessionId: this.sessionId, extensionId: request.extensionId, requestId: request.requestId })
        .catch(() => undefined);
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = local ? local(controller.signal) : this.host.call<T>(method, request, timeoutMs + 5000);
      return await Promise.race([result, aborted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
      controller.signal.removeEventListener("abort", cancel);
      this.pending.delete(controller);
    }
  }

  abort(): void { for (const controller of this.pending) controller.abort(); }
  dispose(): void { this.disposed = true; this.abort(); }
}

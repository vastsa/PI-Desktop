import {
  clampThinkingLevel, completeOneShotMessage, EXTENSION_COMPLETE_TIMEOUT_MS,
  extensionModelError, parseExtensionCompleteRequest, type RuntimeProviderConfig,
  generateHostImages, parseExtensionImageRequest, EXTENSION_IMAGE_TIMEOUT_MS,
} from "@pi-desktop/agent-runtime";

type Dependencies = {
  /** Recheck the current plugin grant and project scope, returning the owner id. */
  authorize(sessionId: string, extensionId: string): Promise<string>;
  resolveProvider(providerId: string, modelId: string): Promise<RuntimeProviderConfig>;
  audit(event: { sessionId: string; extensionId: string; providerId: string; modelId: string; outcome: string }): void;
  now?: () => number;
};

/** One instance per sidecar connection. No credential or transcript leaves this service. */
export class ExtensionModelCompletionService {
  private pending = new Map<string, { sessionId: string; extensionId: string; controller: AbortController }>();
  private admitted = new Map<string, number[]>();
  private disposed = false;
  private deps: Dependencies;
  constructor(deps: Dependencies) { this.deps = deps; }

  async complete(input: unknown) {
    const request = parseExtensionCompleteRequest(input);
    return this.run(request, EXTENSION_COMPLETE_TIMEOUT_MS, async (provider, signal) => {
      const thinkingLevel = clampThinkingLevel(provider, request.options.reasoning ?? "off");
      const result = await completeOneShotMessage(provider, request.context,
        thinkingLevel === "omit" ? "off" : thinkingLevel, {
          signal, maxTokens: request.options.maxTokens, temperature: request.options.temperature,
          sessionId: `extension-complete:${request.requestId}`,
        });
      if (result.stopReason === "error") return { ...result, content: [], errorMessage: "Model completion failed" };
      return result;
    });
  }

  async generateImages(input: unknown) {
    const request = parseExtensionImageRequest(input);
    return this.run(request, EXTENSION_IMAGE_TIMEOUT_MS, (provider, signal) =>
      generateHostImages(provider, request.context, { ...request.options, signal }));
  }

  private async run<T extends { stopReason: string }>(request: {
    sessionId: string; extensionId: string; requestId: string; providerId: string; modelId: string;
    options: { timeoutMs?: number };
  }, defaultTimeout: number, execute: (provider: RuntimeProviderConfig, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposed) throw extensionModelError("TURN_ABORTED", "Extension connection closed");
    if (this.pending.has(request.requestId)) throw extensionModelError("INVALID_ARGUMENT", "Duplicate completion request");
    if (this.pending.size >= 32) throw extensionModelError("RATE_LIMITED", "Too many pending extension completions");
    const controller = new AbortController();
    this.pending.set(request.requestId, { sessionId: request.sessionId, extensionId: request.extensionId, controller });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, request.options.timeoutMs ?? defaultTimeout);
    let rejectAbort: (error: Error) => void = () => {};
    const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const checkAborted = () => {
      if (controller.signal.aborted) throw extensionModelError(timedOut ? "TIMEOUT" : "TURN_ABORTED", "Completion interrupted");
    };
    const abort = () => rejectAbort(extensionModelError(timedOut ? "TIMEOUT" : "TURN_ABORTED", "Completion interrupted"));
    controller.signal.addEventListener("abort", abort, { once: true });
    const run = async () => {
      const owner = await this.deps.authorize(request.sessionId, request.extensionId);
      checkAborted();
      const now = (this.deps.now ?? Date.now)();
      for (const [key, times] of this.admitted) {
        const live = times.filter((time) => time > now - 60_000);
        if (live.length) this.admitted.set(key, live); else this.admitted.delete(key);
      }
      const times = this.admitted.get(owner) ?? [];
      if (times.length >= 8) throw extensionModelError("RATE_LIMITED", "Extension completion rate exceeded");
      this.admitted.set(owner, [...times, now]);
      const provider = await this.deps.resolveProvider(request.providerId, request.modelId);
      checkAborted();
      await this.deps.authorize(request.sessionId, request.extensionId);
      checkAborted();
      const result = await execute(provider, controller.signal);
      checkAborted();
      await this.deps.authorize(request.sessionId, request.extensionId);
      checkAborted();
      return result;
    };
    let outcome = "error";
    try {
      const result = await Promise.race([run(), interrupted]);
      outcome = result.stopReason;
      return result;
    } catch (error) {
      const allowed = ["INVALID_ARGUMENT", "MODEL_NOT_CONFIGURED", "PROVIDER_SECRET_MISSING", "PERMISSION_DENIED", "RATE_LIMITED", "TURN_ABORTED", "TIMEOUT"];
      const code = error && typeof error === "object" && "errorCode" in error && typeof error.errorCode === "string"
        && allowed.includes(error.errorCode) ? error.errorCode : "PROVIDER_ERROR";
      outcome = code;
      throw extensionModelError(code, `Extension completion failed (${code})`);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
      this.pending.delete(request.requestId);
      this.deps.audit({ sessionId: request.sessionId, extensionId: request.extensionId,
        providerId: request.providerId, modelId: request.modelId, outcome });
    }
  }

  cancel(params: Record<string, unknown>) {
    const pending = typeof params.requestId === "string" ? this.pending.get(params.requestId) : undefined;
    if (pending && pending.sessionId === params.sessionId && pending.extensionId === params.extensionId) pending.controller.abort();
    return { ok: true };
  }

  dispose(): void {
    this.disposed = true;
    for (const pending of this.pending.values()) pending.controller.abort();
    this.admitted.clear();
  }
}

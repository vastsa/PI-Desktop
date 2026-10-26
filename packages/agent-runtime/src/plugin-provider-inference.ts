import { createAssistantMessageEventStream, type ProviderStreams, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import {
  validateProviderChatEvent, validateProviderInferenceRequest, inferenceObject,
  PLUGIN_INFERENCE_LIMITS as limits,
  type PluginProviderInferenceBindingV1,
} from "@pi-desktop/plugin-sdk";

export type ProviderInferenceCall = (params: Record<string, unknown>) => Promise<unknown>;
export const PLUGIN_INFERENCE_API = "plugin-inference-v1";
export function pluginProviderStreams(input: {
  id: string; modelId: string; pluginInference: PluginProviderInferenceBindingV1;
  invokeProviderInference?: ProviderInferenceCall;
}): ProviderStreams {
  const call = input.invokeProviderInference;
  if (!call || !input.pluginInference.chat) throw new Error("Plugin inference transport unavailable");
  const stream: ProviderStreams["streamSimple"] = (model, context, options) => {
    const output = createAssistantMessageEventStream();
    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const message: AssistantMessage = { role: "assistant", content: [], api: model.api,
      provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: Date.now() };
    let invocationId: string | undefined;
    let closing: Promise<unknown> | undefined;
    const close = () => {
      if (invocationId && !closing) closing = call({ operation: "close", invocationId });
      return closing;
    };
    const abort = () => { void close()?.catch(() => undefined); };
    const signal = options?.signal;
    const wait = async <T>(promise: Promise<T>): Promise<T> => {
      signal?.throwIfAborted();
      let listener: () => void = () => undefined;
      try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
          listener = () => reject(signal?.reason ?? new Error("Inference aborted"));
          signal?.addEventListener("abort", listener, { once: true });
        })]);
      } finally { signal?.removeEventListener("abort", listener); }
    };
    void (async () => {
      let active: "text" | "thinking" | undefined;
      const endBlock = () => {
        const block = message.content.at(-1);
        const contentIndex = message.content.length - 1;
        if (active === "text" && block?.type === "text") output.push({ type: "text_end", contentIndex, content: block.text, partial: message });
        if (active === "thinking" && block?.type === "thinking") output.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: message });
        active = undefined;
      };
      try {
        signal?.throwIfAborted();
        const request = JSON.parse(JSON.stringify({ version: 1, providerId: input.pluginInference.contributionId,
          modelId: input.modelId, messages: context.messages,
          options: { maxTokens: options?.maxTokens, temperature: options?.temperature,
            reasoning: options?.reasoning } }));
        validateProviderInferenceRequest(request, "chat");
        const opening = call({ operation: "open", request }).then(value => {
          const opened = inferenceObject(value);
          if (typeof opened.invocationId !== "string") throw new Error("Invalid inference invocation");
          invocationId = opened.invocationId;
          // Stop must not wait for open, but a late invocation still needs cleanup.
          if (signal?.aborted) void close()?.catch(error => {
            console.warn("Plugin inference close failed", error instanceof Error ? error.name : "Error");
          });
        });
        await wait(opening);
        signal?.addEventListener("abort", abort, { once: true });
        signal?.throwIfAborted();
        output.push({ type: "start", partial: message });
        let completed = false;
        for (let count = 0; count < limits.events; count++) {
          const event = await wait(call({ operation: "next", invocationId }));
          signal?.throwIfAborted();
          validateProviderChatEvent(event);
          if (event.type === "text" || event.type === "thinking") {
            if (active !== event.type) {
              endBlock();
              active = event.type;
              message.content.push(active === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
              output.push({ type: active === "text" ? "text_start" : "thinking_start", contentIndex: message.content.length - 1, partial: message });
            }
            const block = message.content.at(-1);
            if (event.type === "text" && block?.type === "text") {
              block.text += event.delta;
              if (event.signature !== undefined) block.textSignature = event.signature;
              output.push({ type: "text_delta", delta: event.delta, contentIndex: message.content.length - 1, partial: message });
            } else if (event.type === "thinking" && block?.type === "thinking") {
              block.thinking += event.delta;
              if (event.signature !== undefined) block.thinkingSignature = event.signature;
              if (event.redacted !== undefined) block.redacted = event.redacted;
              output.push({ type: "thinking_delta", delta: event.delta, contentIndex: message.content.length - 1, partial: message });
            }
          } else if (event.type === "toolCall") {
            endBlock();
            if (message.content.some(block => block.type === "toolCall" && block.id === event.id)) throw new Error("Duplicate inference tool call id");
            const toolCall = { ...event };
            message.content.push(toolCall);
            const contentIndex = message.content.length - 1;
            output.push({ type: "toolcall_start", contentIndex, partial: message });
            output.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
          } else if (event.type === "error") {
            throw new Error(event.message);
          } else {
            endBlock();
            const hasCalls = message.content.some(block => block.type === "toolCall");
            if (hasCalls !== (event.stopReason === "toolUse")) throw new Error("Inference completion/tool-call mismatch");
            usage.input = event.usage.input;
            usage.output = event.usage.output;
            usage.cacheRead = event.usage.cacheRead ?? 0;
            usage.cacheWrite = event.usage.cacheWrite ?? 0;
            usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
            message.stopReason = event.stopReason;
            if (event.responseId !== undefined) message.responseId = event.responseId;
            output.push({ type: "done", reason: event.stopReason, message });
            completed = true;
            break;
          }
        }
        if (!completed) throw new Error("Inference event count exceeded");
      } catch (error) {
        message.stopReason = signal?.aborted ? "aborted" : "error";
        message.errorMessage = `Plugin inference failed: ${error instanceof Error ? error.message : String(error)}`;
        output.push({ type: "error", reason: message.stopReason, error: message });
      } finally {
        signal?.removeEventListener("abort", abort);
        try { await close(); }
        catch (error) { console.warn("Plugin inference close failed", error instanceof Error ? error.name : "Error"); }
        output.end();
      }
    })();
    return output;
  };
  return { stream, streamSimple: stream };
}

/** Attach only host reverse RPC, never plugin code or credentials, in either main or delegate bindings. */
export function withPluginProviderInference<T extends { id: string; modelId: string; pluginInference?: PluginProviderInferenceBindingV1 }>(
  sessionId: string, provider: T, host: { call<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> },
): T & { invokeProviderInference?: ProviderInferenceCall } {
  if (!provider.pluginInference) return provider;
  return { ...provider, invokeProviderInference: params => host.call("provider.inference", {
    ...params, sessionId, providerId: provider.id, modelId: provider.modelId,
  }, params.operation === "close" ? 5_000 : limits.callTimeoutMs + 5_000) };
}

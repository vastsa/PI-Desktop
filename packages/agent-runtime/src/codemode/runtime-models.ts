/**
 * Session-side implementation of the codemode `models.*` capabilities. The
 * sandbox only ever sees {@link CodemodeModelInfo}; bindings, headers, and
 * credentials stay here. Each physical request reports its own identified
 * usage, which the runtime emits as a `usage` event so the Host ledger
 * records it against the real account and model.
 */
import type { Context } from "@earendil-works/pi-ai";
import type { MessageUsage } from "@pi-desktop/shared";
import { usageFromPi } from "../agent-messages.js";
import { classifyWithJev, JEV_MODEL_REF } from "../jev-classifier-tool.js";
import { completeOneShot } from "../one-shot-complete.js";
import { buildProviderModel, type RuntimeProviderConfig } from "../provider-binding.js";
import { requestUsageIdentity } from "../request-usage.js";
import type { CodemodeModelHost, CodemodeModelInfo } from "./model-globals.js";

export type RuntimeModelHostOptions = {
  provider: () => RuntimeProviderConfig;
  sessionId: string;
  jevApiKey?: string;
  /** The turn current when a model call starts; late usage stays with it. */
  turnId?: () => string | undefined;
  emitUsage: (usage: MessageUsage, turnId: string | undefined) => void;
  /** Test seam. */
  complete?: typeof completeOneShot;
  classify?: typeof classifyWithJev;
};

function redact(message: string, secrets: Array<string | undefined>): string {
  let text = message;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) text = text.replaceAll(secret, "[redacted]");
  }
  return text;
}

/** Allowlisted metadata of the session's chat model. */
export function chatModelInfo(provider: RuntimeProviderConfig): CodemodeModelInfo {
  const model = buildProviderModel(provider);
  return {
    kind: "chat",
    providerId: provider.id,
    id: model.id,
    ...(model.name ? { name: model.name } : {}),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    input: [...model.input],
  };
}

export function createRuntimeModelHost(options: RuntimeModelHostOptions): CodemodeModelHost {
  const complete = options.complete ?? completeOneShot;
  const classify = options.classify ?? classifyWithJev;
  const jevApiKey = options.jevApiKey;
  return {
    list() {
      const provider = options.provider();
      // A trusted-extension agent streams in process; there is no physical
      // binding a one-shot completion could dispatch to.
      const models: CodemodeModelInfo[] = provider.extensionAgentKey ? [] : [chatModelInfo(provider)];
      if (jevApiKey) {
        models.push({ kind: "classifier", providerId: JEV_MODEL_REF.provider, id: JEV_MODEL_REF.id, name: JEV_MODEL_REF.name });
      }
      return models;
    },
    async complete(request, signal) {
      const provider = options.provider();
      const turnId = options.turnId?.();
      if (provider.extensionAgentKey) {
        throw new Error("models.complete() is unavailable while a trusted extension agent answers this session.");
      }
      const context: Context = {
        ...(request.system ? { systemPrompt: request.system } : {}),
        messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
      };
      try {
        const result = await complete(provider, context, "off", {
          signal,
          maxOutputTokens: request.maxOutputTokens,
          sessionId: options.sessionId,
          onUsage: (usage) => options.emitUsage(usage, turnId),
        });
        return { text: result.text };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(redact(message, [provider.apiKey]));
      }
    },
    ...(jevApiKey
      ? {
          async classify(params: unknown, signal: AbortSignal) {
            const turnId = options.turnId?.();
            // One attempt per call, so one physical request maps to one record.
            const result = await classify(jevApiKey, params, signal, { maxRetries: 0 });
            if (result.usage) {
              const usage = usageFromPi(result.usage, {
                ...requestUsageIdentity(JEV_MODEL_REF, JEV_MODEL_REF.provider),
                ...(Number.isFinite(result.usage.cost?.total) ? { costStatus: "estimated" as const } : {}),
              });
              if (usage) options.emitUsage(usage, turnId);
            }
            return result;
          },
        }
      : {}),
  };
}

import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { MessageUsage, UsageProvenance } from "@pi-desktop/shared";
import { usageFromPi, usageToPi } from "./agent-messages.js";

/** Native rates must be present and finite before a zero cost can mean free use. */
export function nativeCostStatus(cost: Model<Api>["cost"] | undefined): UsageProvenance["costStatus"] {
  if (!cost) return undefined;
  return [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every(rate => Number.isFinite(rate) && rate >= 0)
    ? "estimated" : "unknown";
}

export type UsageObserver = (usage: MessageUsage) => void;

/** Create before dispatch. Each physical retry gets its own identity. */
export function requestUsageIdentity(model: Pick<Model<Api>, "id" | "provider">, providerId?: string): UsageProvenance {
  return { operationId: randomUUID(), usageOrigin: "pi", providerId: providerId ?? model.provider, modelId: model.id };
}

export function accountModelResult(
  message: AssistantMessage,
  identity: UsageProvenance,
  onUsage?: UsageObserver,
): AssistantMessage {
  const usage = usageFromPi(message.usage, identity);
  if (usage) {
    message.usage = usageToPi(usage);
    onUsage?.(usage);
  }
  return message;
}

/**
 * Observe at the real request boundary, inside the retry factory. Intermediate
 * failed paid attempts are reported even when a retry reuses the visible row.
 * The proxy preserves Pi's event stream ownership and cancellation semantics.
 */
export function accountModelStream(
  model: Pick<Model<Api>, "id" | "provider">,
  createStream: () => AssistantMessageEventStream,
  options: { providerId?: string; costStatus?: UsageProvenance["costStatus"]; nativeCost?: Model<Api>["cost"]; onUsage?: UsageObserver } = {},
): AssistantMessageEventStream {
  const costStatus = options.costStatus === "reported" ? "reported"
    : nativeCostStatus(options.nativeCost) ?? options.costStatus;
  const identity = { ...requestUsageIdentity(model, options.providerId),
    ...(costStatus ? { costStatus } : {}) };
  const stream = createStream();
  let reported = false;
  const account = (message: AssistantMessage): AssistantMessage => accountModelResult(message, identity, (usage) => {
    if (reported) return;
    reported = true;
    options.onUsage?.(usage);
  });
  return new Proxy(stream, {
    get(target, property, receiver) {
      if (property === "result") return async () => account(await target.result());
      if (property === Symbol.asyncIterator) return async function* () {
        for await (const event of target) {
          if (event.type === "done") account(event.message);
          if (event.type === "error") account(event.error);
          yield event;
        }
      };
      return Reflect.get(target, property, receiver);
    },
  });
}

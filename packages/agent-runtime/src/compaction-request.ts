/**
 * Outbound headers for the context-compaction summary request.
 *
 * pi-agent-core owns that request: `compact` assembles its own stream options
 * and hands them straight to `Models.completeSimple`, so the call never passes
 * the agent's `streamFn` where every other request of a session picks up its
 * provider headers. OpenCode Go answers 400 to a request without
 * `x-opencode-session`, which is why `/compact` failed on that provider while
 * ordinary turns worked, and a provider row's own custom headers were missing
 * from the same call. `compact` takes the model collection as an argument, so
 * the collection is the seam that reaches its one request.
 */

import type {
  Api,
  Context,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  openCodeEndpointFromProvider,
  withOpenCodeSessionHeaders,
} from "./opencode-session-headers.js";
import {
  copilotRequestHeaders,
  type RuntimeProviderConfig,
} from "./provider-binding.js";
import { mergeProviderHeaders, withProviderHeaders } from "./provider-headers.js";

/**
 * The header set `streamFn` puts on a turn, applied to a summary request.
 *
 * The session id is the runtime's own, not the per-call id pi-agent-core falls
 * back to, so the summary reaches the same gateway backend as the conversation
 * it summarizes — the same id the session's turns already send.
 */
export function compactionRequestOptions(input: {
  provider: RuntimeProviderConfig;
  sessionId: string;
  model: Model<Api>;
  context: Pick<Context, "messages">;
  options?: ModelsSimpleStreamOptions;
}): ModelsSimpleStreamOptions {
  const { provider, sessionId, model, context, options } = input;
  return withProviderHeaders(
    withOpenCodeSessionHeaders(
      { ...options, sessionId },
      { ...openCodeEndpointFromProvider(provider, model), sessionId },
    ),
    mergeProviderHeaders(
      copilotRequestHeaders(provider, context),
      provider.headers,
    ),
  );
}

/**
 * `models` with compaction's request routed through that header boundary.
 *
 * Only `completeSimple` is reached from `compact`; every other member stays the
 * collection's own, so a later pi-agent-core release that calls something else
 * keeps working unchanged.
 */
export function withCompactionRequestHeaders(
  models: Models,
  provider: RuntimeProviderConfig,
  sessionId: string,
): Models {
  const completeSimple: Models["completeSimple"] = (model, context, options) =>
    models.completeSimple(
      model,
      context,
      compactionRequestOptions({ provider, sessionId, model, context, options }),
    );
  return new Proxy(models, {
    get: (target, property, receiver) =>
      property === "completeSimple"
        ? completeSimple
        : Reflect.get(target, property, receiver),
  });
}

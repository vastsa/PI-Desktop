/**
 * Session identity for endpoints the adapters leave anonymous.
 *
 * pi-ai stamps a conversation id by itself only where a vendor documented one:
 * the Responses adapters send it on every request, and the Completions and
 * Anthropic adapters send it only while `compat.sendSessionAffinityHeaders` is
 * set — which defaults to OpenRouter. The Completions body key is narrower
 * still: `prompt_cache_key` is gated on `api.openai.com`. A self-hosted gateway
 * or a relay therefore sees every session of one credential as the same
 * conversation, so it can pin a conversation to no particular backend and has
 * no per-session basis for isolating a prompt cache.
 *
 * This module stamps that identity for endpoints the user pointed at
 * themselves, so a gateway can read one conversation per session again. A row
 * that still resolves to a published vendor host keeps its current request
 * bytes: those vendors' caching semantics are not ours to change, and the
 * OpenCode path already carries its own session header.
 *
 * The two channels answer different questions and are both needed: the headers
 * let a gateway route a conversation to one backend, the body key lets an
 * upstream isolate its prompt cache.
 */

import { addressesPublishedVendorHost } from "@pi-desktop/shared";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { clampOpenAIPromptCacheKey } from "@earendil-works/pi-ai/api/openai-prompt-cache";
import { isOpenCodeEndpoint } from "./opencode-session-headers.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

/** Wire APIs where PI-Desktop preserves session identity for custom endpoints. */
const SESSION_AFFINITY_APIS: ReadonlySet<string> = new Set([
  "openai-completions",
  "anthropic-messages",
  "openai-responses",
]);

/** Wire APIs whose adapter reads session headers from `compat`. */
const SESSION_AFFINITY_COMPAT_APIS: ReadonlySet<string> = new Set([
  "openai-completions",
  "anthropic-messages",
]);

/** Responses has native session headers, but needs this proxy-safe alias. */
const SESSION_AFFINITY_OPTION_HEADER_APIS: ReadonlySet<string> = new Set([
  "openai-responses",
]);

/** Wire APIs that carry the conversation key in the request body. */
const SESSION_AFFINITY_BODY_APIS: ReadonlySet<string> = new Set([
  "openai-completions",
]);

export type SessionAffinityCompat = {
  sendSessionAffinityHeaders: true;
  sessionAffinityFormat: "openai";
};

/** The provider fields that decide whether this row is the user's own endpoint. */
export type SessionAffinityProvider = Pick<RuntimeProviderConfig, "apiStyle" | "vendorKey">;

/**
 * Whether PI-Desktop stamps this request itself.
 *
 * False for every endpoint that already answers the question: a wire API with
 * no session channel, the OpenCode path (whose own header is applied
 * separately), and any row whose base URL is still a published vendor host.
 */
export function providerUsesSessionAffinity(
  provider: SessionAffinityProvider,
  api: string,
  baseUrl: string | undefined,
): boolean {
  if (!SESSION_AFFINITY_APIS.has(api)) return false;
  if (
    isOpenCodeEndpoint({
      apiStyle: provider.apiStyle,
      vendorKey: provider.vendorKey,
      baseUrl,
    })
  ) {
    return false;
  }
  return !addressesPublishedVendorHost(baseUrl);
}

/**
 * The model `compat` entry that makes the adapter write the session headers.
 *
 * `openai` is the adapter's own non-OpenRouter shape: `x-session-affinity` and
 * `x-client-request-id` beside `session_id`. The Anthropic adapter reads the
 * same flag and, for any format but `openrouter`, writes `x-session-affinity`.
 * An endpoint reached through a provider row's own `compat` keeps its say: this
 * value is spread under it, so an explicit catalog entry still wins.
 */
export function sessionAffinityCompat(
  provider: SessionAffinityProvider,
  api: string,
  baseUrl: string | undefined,
): SessionAffinityCompat | undefined {
  return SESSION_AFFINITY_COMPAT_APIS.has(api) &&
      providerUsesSessionAffinity(provider, api, baseUrl)
    ? { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openai" }
    : undefined;
}

/**
 * Add the conversation key to the request body when this endpoint is stamped
 * and the adapter would not have added one itself.
 *
 * A payload that already carries the key is returned untouched, and so is a
 * payload the adapter did not hand over as a plain object. The adapter's own
 * object is never mutated: the key rides a shallow copy, so a caller's
 * `onPayload` return value can still replace the whole payload.
 */
export function withSessionPromptCacheKey(input: {
  payload: unknown;
  api: string;
  sessionId: string | undefined;
  enabled: boolean;
}): unknown {
  const { payload, api, sessionId, enabled } = input;
  if (!enabled || !SESSION_AFFINITY_BODY_APIS.has(api)) return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const body = payload as Record<string, unknown>;
  if (body.prompt_cache_key !== undefined && body.prompt_cache_key !== null) {
    return payload;
  }
  const key = clampOpenAIPromptCacheKey(sessionId?.trim() || undefined);
  if (!key) return payload;
  return { ...body, prompt_cache_key: key };
}

/**
 * `options` with session identity appended at the request boundary. Responses
 * already emits `session_id`, but common reverse proxies drop underscore
 * headers; add the stable hyphenated alias for custom endpoints. Completions
 * gets its missing body key after every other `onPayload` hook, so a
 * payload-rewriting extension cannot drop it.
 *
 * An endpoint that is not stamped, or a wire API with no body channel, gets
 * its options back unchanged — no hook is installed and the request object
 * stays the one the caller built. A stamped endpoint takes the hook even for a
 * caller with no session id; there the hook adds nothing and the adapter keeps
 * its own payload.
 */
export function withSessionAffinityOptions(
  options: SimpleStreamOptions,
  input: {
    provider: SessionAffinityProvider;
    api: string;
    baseUrl: string | undefined;
    sessionId: string | undefined;
  },
): SimpleStreamOptions {
  const enabled = providerUsesSessionAffinity(input.provider, input.api, input.baseUrl);
  if (!enabled) return options;

  const sessionId = input.sessionId?.trim();
  let nextOptions = options;
  if (sessionId && SESSION_AFFINITY_OPTION_HEADER_APIS.has(input.api)) {
    const headers = { ...(options.headers ?? {}) };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "x-session-affinity") delete headers[key];
    }
    nextOptions = {
      ...options,
      headers: { ...headers, "x-session-affinity": sessionId },
    };
  }

  if (!SESSION_AFFINITY_BODY_APIS.has(input.api)) return nextOptions;
  const previous = nextOptions.onPayload;
  return {
    ...nextOptions,
    onPayload: async (payload, model) => {
      const replacement = await previous?.(payload, model);
      const base = replacement === undefined ? payload : replacement;
      const keyed = withSessionPromptCacheKey({
        payload: base,
        api: model.api,
        sessionId,
        enabled,
      });
      // Nothing to change keeps the hook's own return value, so an untouched
      // payload stays the adapter's object instead of a copy of it.
      return keyed === base ? replacement : keyed;
    },
  };
}

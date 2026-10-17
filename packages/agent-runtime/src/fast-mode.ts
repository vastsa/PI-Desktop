/**
 * OpenAI Fast mode on the request body (ADR 0331).
 *
 * pi-ai's `streamSimple` does not forward a service tier, so the priority tier
 * is set through the payload hook, the same channel the session-affinity body
 * key uses. The launcher has already combined the session `/fast` switch with
 * the model binding's opt-in; the hook still reads the wire of the model being
 * called, so a request that does not travel on a Responses wire keeps its bytes.
 */

import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { FAST_MODE_SERVICE_TIER, fastModeSupportedOn } from "@pi-desktop/shared";

/** Chain a payload hook that asks for the priority tier when Fast mode is on. */
export function withFastModeOptions(
  options: SimpleStreamOptions,
  fastMode: boolean,
): SimpleStreamOptions {
  if (fastMode !== true) return options;
  const previous = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      const replacement = await previous?.(payload, model);
      const base = replacement === undefined ? payload : replacement;
      if (!isRecord(base) || !fastModeSupportedOn(model.api)) return replacement;
      return { ...base, service_tier: FAST_MODE_SERVICE_TIER };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

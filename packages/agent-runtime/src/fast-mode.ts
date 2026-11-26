/**
 * OpenAI Fast mode (ADR 0334). The launcher has already combined the session
 * `/fast` switch with the model binding's opt-in; pi-ai's Responses adapters
 * send `serviceTier` as `service_tier` and price the tier the response reports.
 */

import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { FAST_MODE_TIER_SERVICE_TIER, fastModeSupportedOn, type FastModeTier } from "@pi-desktop/shared";

/**
 * Ask for the session's tier on a wire that carries it; other wires keep their
 * options. pi-ai's type lists only the tiers it prices, but its Responses
 * adapters forward the value verbatim, so `ultrafast` (#2507) reaches the wire.
 */
export function withFastModeOptions(
  options: SimpleStreamOptions,
  api: string,
  fastMode: boolean,
  tier: FastModeTier = "fast",
): SimpleStreamOptions {
  if (!fastMode || !fastModeSupportedOn(api)) return options;
  return { ...options, serviceTier: FAST_MODE_TIER_SERVICE_TIER[tier] as SimpleStreamOptions["serviceTier"] };
}

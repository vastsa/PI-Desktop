/**
 * OpenAI Fast mode (ADR 0334). The launcher has already combined the session
 * `/fast` switch with the model binding's opt-in; pi-ai's Responses adapters
 * send `serviceTier` as `service_tier` and price the tier the response reports.
 */

import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { FAST_MODE_SERVICE_TIER, fastModeSupportedOn } from "@pi-desktop/shared";

/** Ask for the priority tier on a wire that carries it; other wires keep their options. */
export function withFastModeOptions(
  options: SimpleStreamOptions,
  api: string,
  fastMode: boolean,
): SimpleStreamOptions {
  return fastMode && fastModeSupportedOn(api) ? { ...options, serviceTier: FAST_MODE_SERVICE_TIER } : options;
}

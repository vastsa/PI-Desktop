/**
 * OpenAI Fast mode (ADR 0334): the Responses body field
 * `service_tier: "priority"`. A request asks for it only when the model
 * binding's `fastModeAllowed` and the session `/fast` switch are both on.
 * `/ultrafast` uses the same switch and opt-in with the `ultrafast` tier.
 */
export const FAST_MODE_SERVICE_TIER = "priority";

/**
 * The tier a session's speed switch asks for (#2507). `fast` is OpenAI's
 * priority tier, chosen by `/fast`; `ultrafast` is the faster tier, chosen
 * by `/ultrafast`. Both need the binding's `fastModeAllowed`.
 */
export const FAST_MODE_TIERS = ["fast", "ultrafast"] as const;
export type FastModeTier = (typeof FAST_MODE_TIERS)[number];

/** The Responses `service_tier` value sent for each session tier. */
export const FAST_MODE_TIER_SERVICE_TIER: Record<FastModeTier, string> = {
  fast: FAST_MODE_SERVICE_TIER,
  ultrafast: "ultrafast",
};

export function isFastModeTier(value: unknown): value is FastModeTier {
  return value === "fast" || value === "ultrafast";
}

/** Missing or unknown stored values mean `fast`, the only tier older hosts knew. */
export function normalizeFastModeTier(value: unknown): FastModeTier {
  return isFastModeTier(value) ? value : "fast";
}

/** `subscription` spends ChatGPT plan limits; `usage` is billed per token. */
export type FastModeBilling = "subscription" | "usage";

/** Stored apiStyle and resolved wire spellings of the wires that carry the tier. */
const FAST_MODE_BILLING: Record<string, FastModeBilling> = {
  openai_codex_responses: "subscription",
  "openai-codex-responses": "subscription",
  responses: "usage",
  "openai-responses": "usage",
};

/** How the tier is paid for on this apiStyle or wire, or undefined when it cannot carry it. */
export function fastModeBillingOn(api: string | undefined | null): FastModeBilling | undefined {
  return FAST_MODE_BILLING[(api ?? "").trim().toLowerCase()];
}

export function fastModeSupportedOn(api: string | undefined | null): boolean {
  return fastModeBillingOn(api) !== undefined;
}

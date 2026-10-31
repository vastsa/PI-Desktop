/**
 * OpenAI Fast mode (ADR 0334): the Responses body field
 * `service_tier: "priority"`. A request asks for it only when the model
 * binding's `fastModeAllowed` and the session `/fast` switch are both on.
 */
export const FAST_MODE_SERVICE_TIER = "priority";

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

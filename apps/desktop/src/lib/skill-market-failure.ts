import { ErrorCodes } from "@pi-desktop/shared";

/**
 * Why a skill market request failed, as far as the renderer can tell.
 *
 * `policy` means the main process refused the fetch inside its public-network
 * guard, and that refusal judged an address (or the URL itself): a verdict that
 * the destination is not a public host.
 *
 * `unresolved` means the guard reached no verdict at all — the local DNS lookup
 * returned no answer. The guard classifies the host with a *local* resolver,
 * while the request itself would have gone through the configured proxy
 * (ADR 0177, ADR 0243). A user behind a proxy or TUN resolver that answers DNS
 * itself — Clash fake-IP in `198.18.0.0/15`, a corporate split resolver, an
 * offline resolver — can hit either case, and the two need different advice:
 * one is about the destination, the other about the resolver. Keeping them
 * apart is the whole point of surfacing this instead of one generic failure
 * (issue #419).
 */
export type SkillMarketFailureKind = "policy" | "unresolved" | "network";

/** Classify a rejected `api.fetchSkillMarketDocument` / search call. */
export function classifySkillMarketFailure(error: unknown): SkillMarketFailureKind {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === ErrorCodes.NETWORK_POLICY_BLOCKED) return "policy";
  if (code === ErrorCodes.NETWORK_RESOLVE_FAILED) return "unresolved";
  return "network";
}

/**
 * The main-process reason, kept verbatim for the install sheet. It is internal
 * English text, but it names the failing host only — the URL shown next to it
 * in the sheet is already the same public HTTPS address, and the guard rejects
 * credential-bearing URLs, so this adds no secret to the screen.
 */
export function skillMarketFailureDetail(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  return "";
}

/**
 * Whether a list of failed sources contains at least one policy refusal — a
 * verdict on an address — which is what makes the address-check explanation and
 * its resolver hint worth showing.
 */
export function hasPolicyFailure(kinds: Record<string, unknown> | undefined): boolean {
  return Object.values(kinds ?? {}).includes("policy");
}

/**
 * Whether any source failed because the local resolver had no answer. Always
 * checked *after* `hasPolicyFailure`: when both are present the panel leads with
 * the stronger, address-level refusal.
 */
export function hasUnresolvedFailure(kinds: Record<string, unknown> | undefined): boolean {
  return Object.values(kinds ?? {}).includes("unresolved");
}

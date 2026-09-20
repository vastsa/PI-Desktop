import { ErrorCodes, isProxyFakeIpAddress, type PublicNetworkAddressKind } from "@pi-desktop/shared";

/**
 * Why a skill market request failed, as far as the renderer can tell.
 *
 * `policy` means the main process refused the fetch inside its public-network
 * guard because it judged an address, and that address was the target's own.
 *
 * `fake-ip` is that same refusal applied to an address the *local proxy* invented
 * for the name — Clash, Mihomo, sing-box and Surge all ship `198.18.0.0/15` as
 * their default fake-IP pool. It is refused exactly as any other non-public
 * address, so it is not a weaker finding; it is a different one, and only advice
 * about the proxy mode helps. The guard classifies the host with a *local*
 * resolver while the request itself would go through that proxy (ADR 0177,
 * ADR 0243), so this case says nothing about the source.
 *
 * `unresolved` means the guard reached no verdict at all: the local DNS lookup
 * returned no answer.
 *
 * Keeping these apart is the whole point of surfacing them instead of one
 * generic failure (issue #419).
 */
export type SkillMarketFailureKind = "policy" | "fake-ip" | "unresolved" | "network";

/** Classify a rejected `api.fetchSkillMarketDocument` / search call. */
export function classifySkillMarketFailure(error: unknown): SkillMarketFailureKind {
  // `wrap()` forwards the guard's own `data` as this error's `details`, so the
  // structured reason survives the IPC boundary. A judged fake-IP and a judged
  // private target arrive under one code — both are refusals the guard decided —
  // which makes the author's address class the only honest way to separate them.
  const details = (
    error as { details?: { reason?: unknown; addressKind?: unknown } } | null | undefined
  )?.details;
  if (
    details?.reason === "non-public-address" &&
    isProxyFakeIpAddress(details.addressKind as PublicNetworkAddressKind | undefined)
  ) {
    return "fake-ip";
  }
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === ErrorCodes.NETWORK_POLICY_BLOCKED) return "policy";
  if (code === ErrorCodes.NETWORK_RESOLVE_FAILED) return "unresolved";
  return "network";
}

/**
 * The main-process reason, kept verbatim for the install sheet. It is internal
 * English text, but it names the failing host and the address it resolved to
 * only — the URL shown next to it in the sheet is already the same public HTTPS
 * address, and the guard rejects credential-bearing URLs, so this adds no secret
 * to the screen.
 */
export function skillMarketFailureDetail(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  return "";
}

/**
 * Whether a list of failed sources contains at least one refusal of the target's
 * own address — the strongest finding, because it is about the destination
 * rather than about the machine's resolver or proxy mode.
 */
export function hasPolicyFailure(kinds: Record<string, unknown> | undefined): boolean {
  return Object.values(kinds ?? {}).includes("policy");
}

/**
 * Whether any source was refused on an address the local proxy invented. Checked
 * after `hasPolicyFailure`: when both are present the panel leads with the
 * destination-level finding, which is the more serious of the two.
 */
export function hasFakeIpFailure(kinds: Record<string, unknown> | undefined): boolean {
  return Object.values(kinds ?? {}).includes("fake-ip");
}

/**
 * Whether any source failed because the local resolver had no answer. Checked
 * last: it is the least specific of the three causes.
 */
export function hasUnresolvedFailure(kinds: Record<string, unknown> | undefined): boolean {
  return Object.values(kinds ?? {}).includes("unresolved");
}

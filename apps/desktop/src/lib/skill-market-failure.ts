import { ErrorCodes } from "@pi-desktop/shared";

/**
 * Why a skill market request failed, as far as the renderer can tell.
 *
 * `policy` means the main process refused the fetch inside its public-network
 * guard, so the request never reached the network. The guard classifies the
 * host with a *local* DNS lookup, while the request itself would have gone
 * through the configured proxy (ADR 0177, ADR 0243). A user behind a proxy or
 * TUN resolver that answers DNS itself — Clash fake-IP in `198.18.0.0/15`, a
 * corporate split resolver, an offline resolver — gets a policy refusal for a
 * URL that opens fine in their browser. That distinction is the whole point of
 * surfacing this: it tells the user to look at the proxy setting instead of
 * assuming the source is down.
 */
export type SkillMarketFailureKind = "policy" | "network";

/** Classify a rejected `api.fetchSkillMarketDocument` / search call. */
export function classifySkillMarketFailure(error: unknown): SkillMarketFailureKind {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === ErrorCodes.NETWORK_POLICY_BLOCKED ? "policy" : "network";
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
 * Whether a list of failed sources contains at least one policy refusal, which
 * is what makes the app-level proxy hint worth showing.
 */
export function hasPolicyFailure(kinds: Record<string, unknown> | undefined): boolean {
  return Object.values(kinds ?? {}).includes("policy");
}

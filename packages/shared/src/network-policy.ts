/**
 * Trust policy for the network endpoints a user enters themselves.
 *
 * Address judgement lives in `public-network.ts`, which answers "is this
 * address public?". This module answers the separate question the app asks
 * before it applies that judgement: "how much does this app trust the endpoints
 * the user typed?".
 *
 * Endpoints the user typed — a model base URL, an MCP server, a market source,
 * a git remote, a WebDAV root — are that person's own choice, so the relaxed
 * mode treats loopback and LAN addresses as reachable, allows plain `http`, and
 * tolerates a transparent proxy's fake-IP answers. Content the app did not
 * receive from the user — a registry record, a market catalog body, an HTTP
 * redirect target — keeps the strict public-network policy in either mode,
 * because that is where the SSRF risk lives.
 */

export const NETWORK_POLICY_MODES = ["relaxed", "strict"] as const;

/**
 * Who chose the address one request is judged for.
 *
 * `user` is an endpoint the person typed into a settings field: their own
 * machine, their own LAN service, their own public server. `third-party` is
 * everything the app did not receive from them — a redirect target, a catalog
 * body, a registry record — which keeps the strict public-network policy in
 * either mode, because that is the input an attacker controls.
 */
export type EndpointOrigin = "user" | "third-party";
export type NetworkPolicyMode = (typeof NETWORK_POLICY_MODES)[number];

/** `settings.networkPolicy`. */
export type NetworkPolicySettings = {
  /**
   * `relaxed` is the default: an endpoint the user typed may be a loopback or
   * LAN address, plain `http` is usable, and a TUN proxy's fake-IP answers are
   * tolerated. `strict` keeps the public-HTTPS-only boundary for those endpoints
   * too.
   */
  mode?: NetworkPolicyMode;
  /**
   * Set once the app has told the user that a plaintext hop to their own LAN is
   * in use. The notice is informational; the mode stays what it was.
   */
  insecureNoticeAcknowledged?: boolean;
};

export const DEFAULT_NETWORK_POLICY: NetworkPolicySettings = { mode: "relaxed" };

/** Keep only the fields this policy defines, with their usable values. */
export function normalizeNetworkPolicy(value: unknown): NetworkPolicySettings {
  const record =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const stored =
    record.mode === "strict" || record.mode === "relaxed" ? record.mode : undefined;
  // A build before the mode existed stored one bare flag for the plaintext case.
  // Its `false` is the user's own answer, so it survives as `strict`; its `true`
  // and its absence both mean the default, `relaxed`.
  const legacy = record.allowInsecureUserEndpoints;
  const next: NetworkPolicySettings = {
    mode: stored ?? (legacy === false ? "strict" : "relaxed"),
  };
  if (record.insecureNoticeAcknowledged === true) {
    next.insecureNoticeAcknowledged = true;
  }
  return next;
}

export type ValidateNetworkPolicyResult =
  | { ok: true; value: NetworkPolicySettings }
  | { ok: false; error: string };

export function validateNetworkPolicy(value: unknown): ValidateNetworkPolicyResult {
  if (value === undefined || value === null) {
    return { ok: true, value: { ...DEFAULT_NETWORK_POLICY } };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "networkPolicy must be an object" };
  }
  const record = value as Record<string, unknown>;
  if (
    record.mode !== undefined &&
    record.mode !== "relaxed" &&
    record.mode !== "strict"
  ) {
    return { ok: false, error: "networkPolicy.mode must be relaxed or strict" };
  }
  if (
    record.insecureNoticeAcknowledged !== undefined &&
    typeof record.insecureNoticeAcknowledged !== "boolean"
  ) {
    return {
      ok: false,
      error: "insecureNoticeAcknowledged must be a boolean",
    };
  }
  return { ok: true, value: normalizeNetworkPolicy(value) };
}

/**
 * Whether the relaxed mode is in force for `settings`. Absent settings and an
 * absent `networkPolicy` section both mean yes: that is the documented default.
 */
export function isRelaxedNetworkPolicy(settings: unknown): boolean {
  const section =
    settings && typeof settings === "object"
      ? (settings as { networkPolicy?: unknown }).networkPolicy
      : undefined;
  return normalizeNetworkPolicy(section).mode !== "strict";
}

/**
 * The reading every plaintext decision uses: relaxed mode is what allows a
 * plain `http` hop to an endpoint the user typed.
 */
export function allowInsecureUserEndpoints(settings: unknown): boolean {
  return isRelaxedNetworkPolicy(settings);
}

/** Whether the one-time plaintext notice still owes the user an explanation. */
export function needsInsecureEndpointNotice(settings: unknown): boolean {
  const section =
    settings && typeof settings === "object"
      ? (settings as { networkPolicy?: unknown }).networkPolicy
      : undefined;
  const policy = normalizeNetworkPolicy(section);
  return policy.mode !== "strict" && policy.insecureNoticeAcknowledged !== true;
}

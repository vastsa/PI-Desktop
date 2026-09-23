/**
 * The network policy in force for the endpoints the user enters themselves, as
 * the main process currently holds it.
 *
 * The policy itself lives in `@pi-desktop/shared` (`network-policy.ts`). The
 * one mode it defines is `relaxed` — the default — which treats a loopback or
 * LAN address the user typed as reachable, allows plain `http` to it, and
 * tolerates a TUN proxy's fake-IP answers; `strict` keeps the public-HTTPS-only
 * boundary for those endpoints too. Content the app did not receive from the
 * user keeps the strict public-network rule in either mode. The public network
 * client runs synchronously per request, so the stored settings value is
 * mirrored here whenever the host hands the app its settings, exactly as
 * `network-proxy.ts` mirrors the proxy.
 */
import {
  DEFAULT_NETWORK_POLICY,
  isRelaxedNetworkPolicy,
  needsInsecureEndpointNotice as policyNeedsInsecureEndpointNotice,
  normalizeNetworkPolicy,
  type NetworkPolicySettings,
} from "@pi-desktop/shared";

let applied: NetworkPolicySettings = { ...DEFAULT_NETWORK_POLICY };

/**
 * Whether this process has already told the user that a plaintext hop to their
 * own LAN is in use. It starts out as the stored answer and moves the moment
 * the notice is shown; the renderer writes `insecureNoticeAcknowledged` back
 * through the settings it already saves.
 */
let noticeAcknowledged = false;

function networkPolicySection(settings: unknown): unknown {
  return settings && typeof settings === "object"
    ? (settings as { networkPolicy?: unknown }).networkPolicy
    : undefined;
}

/**
 * Mirror the stored `networkPolicy` section; returns whether the relaxed mode
 * is in force. An absent section means the documented default, `relaxed`.
 */
export function applyUserEndpointPolicyFromAppSettings(settings: unknown): boolean {
  applied = normalizeNetworkPolicy(networkPolicySection(settings));
  noticeAcknowledged = applied.insecureNoticeAcknowledged === true;
  return relaxedNetworkPolicyEnabled();
}

/**
 * Whether plain `http` is currently allowed for a user-supplied endpoint. This
 * is the relaxed mode; only `strict` turns it off.
 */
export function allowInsecureUserEndpointsEnabled(): boolean {
  return relaxedNetworkPolicyEnabled();
}

/**
 * Whether the relaxed mode is in force. The same answer as
 * {@link allowInsecureUserEndpointsEnabled}, named for the decisions the mode
 * itself owns (fake-IP tolerance, the one-time plaintext notice) so a call site
 * never has to guess what the older name meant.
 */
export function relaxedNetworkPolicyEnabled(): boolean {
  return isRelaxedNetworkPolicy({ networkPolicy: applied });
}

/** Whether the one-time plaintext notice still owes the user an explanation. */
export function needsInsecureEndpointNotice(): boolean {
  if (noticeAcknowledged) return false;
  return policyNeedsInsecureEndpointNotice({ networkPolicy: applied });
}

/**
 * Record that the one-time plaintext notice has been shown. Only the in-process
 * flag moves here; persisting `networkPolicy.insecureNoticeAcknowledged` is the
 * renderer's settings write.
 */
export function acknowledgeInsecureEndpointNotice(): void {
  noticeAcknowledged = true;
  applied = { ...applied, insecureNoticeAcknowledged: true };
}

/** The shell that can show the one-time plaintext notice, once main has one. */
let noticeSink: ((host: string) => void) | null = null;
/** Main's own guard against repeating a notice the renderer has not yet saved. */
let noticeSent = false;

/**
 * Wire the renderer. `main/index.ts` points this at `sendToRenderer`, so the
 * notice travels the same channel as every other host-originated event.
 */
export function setInsecureEndpointNoticeSink(
  sink: ((host: string) => void) | null,
): void {
  noticeSink = sink;
}

/**
 * A hop is about to travel as plain `http` to an endpoint the user typed. Tell
 * the shell once, and only while the stored settings still owe the notice: the
 * renderer saves `networkPolicy.insecureNoticeAcknowledged` after showing it.
 *
 * This is informational. The relaxed mode is already in force and the request
 * proceeds; nothing here can block one.
 */
export function noteInsecureUserEndpoint(host: string): void {
  if (!relaxedNetworkPolicyEnabled()) return;
  if (noticeSent) return;
  if (!needsInsecureEndpointNotice()) {
    noticeSent = true;
    return;
  }
  noticeSent = true;
  noticeSink?.(host);
}

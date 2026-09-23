/**
 * The one-time plaintext notice for the relaxed network mode (ADR 0304).
 *
 * The mode is on by default, so the first `http` hop to an endpoint the user
 * typed is worth saying out loud once: whatever that endpoint accepts travels
 * unencrypted across the local network. `endpoint-policy.ts` decides *when* —
 * it already holds the mode and the acknowledgement — and this module turns that
 * decision into the renderer event, keeping the wiring out of `main/index.ts`,
 * which owns a hard line budget.
 */
import { IPC } from "@pi-desktop/shared";
import { setInsecureEndpointNoticeSink } from "./endpoint-policy";

export type RendererSend = (channel: string, payload: unknown) => void;

/**
 * Point the policy at the renderer. The shell owns the wording and records
 * `networkPolicy.insecureNoticeAcknowledged` in settings after showing it.
 */
export function installInsecureEndpointNotice(send: RendererSend): void {
  setInsecureEndpointNoticeSink((host) => {
    send(IPC.event.insecureEndpointNotice, { host });
  });
}

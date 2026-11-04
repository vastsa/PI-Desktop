/**
 * The computer-use channels the renderer may call (ADR 0340).
 *
 * Deliberately short: read what the platform can do, list windows while the
 * picker is open, mint a grant from a window the user chose, revoke one, and
 * read the live grant. There is no channel here that dispatches input — the
 * renderer must never hold that authority — and every call is pinned to the
 * trusted main window, so a plugin view or the cursor overlay cannot mint a
 * grant.
 */
import { IPC, type ComputerCapabilities, type ComputerGrantView } from "@pi-desktop/shared";
import { capturePermissionState } from "../computer-use/capture";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export type ComputerIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => Pick<HostProcess, "call"> | null;
  /** Push the grant to the indicator and close the overlay when it ends. */
  publishGrant: (grant: ComputerGrantView | null) => void;
};

function hostUnavailable(): never {
  throw Object.assign(new Error("Host unavailable."), { errorCode: "HOST_UNAVAILABLE" });
}

export function registerComputerIpc({ registrar, getHost, publishGrant }: ComputerIpcDependencies): void {
  registrar.handleWithEvent(IPC.invoke.computerCapabilities, async (event) => {
    registrar.assertMainWindowSender(event);
    const host = getHost();
    if (!host) hostUnavailable();
    const capabilities = await host.call<ComputerCapabilities>("computer.capabilities", {});
    // host-core cannot answer for the capture path: that one is Chromium's.
    return { ...capabilities, capture: capturePermissionState() };
  });

  registrar.handleWithEvent(IPC.invoke.computerListTargets, async (event) => {
    registrar.assertMainWindowSender(event);
    const host = getHost();
    if (!host) hostUnavailable();
    return host.call("computer.listTargets", {});
  });

  registrar.handleWithEvent(IPC.invoke.computerGrantCreate, async (event, request: unknown) => {
    registrar.assertMainWindowSender(event);
    const host = getHost();
    if (!host) hostUnavailable();
    const input = (request ?? {}) as Record<string, unknown>;
    // The renderer may name a target, a session, and the two policy choices
    // the grant card showed; everything else — the handle behind the target,
    // the budget ceiling, the refusals — is the host's.
    const grant = await host.call<ComputerGrantView>("computer.grantCreate", {
      targetId: input.targetId,
      sessionId: input.sessionId,
      ...(input.inputPolicy ? { inputPolicy: input.inputPolicy } : {}),
      ...(input.capture ? { capture: input.capture } : {}),
    });
    publishGrant(grant);
    return grant;
  });

  registrar.handleWithEvent(IPC.invoke.computerGrantRevoke, async (event, request: unknown) => {
    registrar.assertMainWindowSender(event);
    const host = getHost();
    if (!host) hostUnavailable();
    const input = (request ?? {}) as Record<string, unknown>;
    const result = await host.call<{ revoked: boolean }>("computer.grantRevoke", {
      ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
    });
    publishGrant(null);
    return result;
  });

  registrar.handleWithEvent(IPC.invoke.computerGrantDescribe, async (event) => {
    registrar.assertMainWindowSender(event);
    const host = getHost();
    if (!host) hostUnavailable();
    return host.call<{ grant: ComputerGrantView | null }>("computer.grantDescribe", {});
  });
}

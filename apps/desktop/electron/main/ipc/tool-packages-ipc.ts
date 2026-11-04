/**
 * `toolPackages.*` IPC bridge (D681).
 *
 * The host owns both halves of the feature: it scans the bundled
 * `resources/tools` directory and persists the enabled set under the data
 * directory. Parameters are narrowed here so the IPC boundary never forwards a
 * shape the renderer invented — the host validates again, but a mistyped field
 * should not travel at all.
 */
import { IPC } from "@pi-desktop/shared";

import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

const MAX_ID_CHARS = 200;

function toggleParams(input: unknown): { id: string; enabled: boolean } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("toolPackages.setEnabled expects { id, enabled }");
  }
  const raw = input as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim().slice(0, MAX_ID_CHARS) : "";
  if (!id) throw new Error("toolPackages.setEnabled expects a non-empty id");
  if (typeof raw.enabled !== "boolean") {
    throw new Error("toolPackages.setEnabled expects a boolean enabled");
  }
  return { id, enabled: raw.enabled };
}

export function registerToolPackagesIpc({
  registrar,
  getHost,
}: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
}): void {
  registrar.handle(IPC.invoke.toolPackagesList, async () => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    return host.call("toolPackages.list", {});
  });

  registrar.handle(IPC.invoke.toolPackagesSetEnabled, async (input?: unknown) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    return host.call("toolPackages.setEnabled", toggleParams(input));
  });
}

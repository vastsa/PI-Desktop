import type { SessionCapabilities, SessionSummary } from "@pi-desktop/shared";

export function isRemoteSession(session?: Pick<SessionSummary, "id" | "source"> | null): boolean {
  return session?.source === "remote" || session?.id?.startsWith("remote:") === true;
}

/** Missing capabilities preserve local behavior, but never grant remote local access. */
export function sessionAllows(
  session: Pick<SessionSummary, "id" | "source" | "capabilities"> | undefined,
  capability: keyof SessionCapabilities,
): boolean {
  if (isRemoteSession(session)) {
    return ["canPrompt", "canStop", "canRefresh", "canReadWorkspace"].includes(capability)
      && session?.capabilities?.[capability] === true;
  }
  return session?.capabilities?.[capability] !== false;
}

/** A remote path is display data, not an Electron workspace activation target. */
export function safeSessionSummary<T extends SessionSummary>(session: T): T {
  if (!isRemoteSession(session)) return session;
  const { projectPath: _localPath, ...safe } = session;
  return { ...safe, source: "remote" } as T;
}

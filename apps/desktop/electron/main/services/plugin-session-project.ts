import type { GroupHost } from "../workspace-roots";

/** Resolve scope from durable metadata, including sessions with no live runtime. */
export function createPluginSessionProjectResolver(
  getHost: () => GroupHost | null,
): (sessionId: string) => Promise<string | null> {
  return async (sessionId) => {
    const host = getHost();
    if (!host?.isAvailable()) return null;
    try {
      const result = (await host.call(
        "session.get",
        { id: sessionId, messageLimit: 1 },
        5_000,
      )) as {
        session?: { projectPath?: string | null } | null;
      } | null;
      if (getHost() !== host || !host.isAvailable()) return null;
      const path = result?.session?.projectPath;
      return typeof path === "string" && path.trim() ? path : null;
    } catch {
      // Missing/invalid metadata and unavailable hosts never widen activation scope.
      return null;
    }
  };
}

/**
 * What the renderer may offer for a session, read from the capabilities
 * Electron main attaches to its summary. A desktop session omits the optional
 * flags and keeps every surface; a remote session turns off the surfaces that
 * have no host operation, and a native pi session keeps its own read-only
 * rules. Surfaces ask this module rather than testing `source` themselves, so a
 * new session source changes one place.
 */
import type { SessionSummary } from "@pi-desktop/shared";

export type SessionSurfaceGates = {
  /** The session runs on a paired remote host. */
  remote: boolean;
  /** Attachments and `@` file references can be added. */
  canAttach: boolean;
  /** The provider, model, and thinking pickers apply to this session. */
  canSelectModel: boolean;
  /** Alt+Enter may steer a running turn; otherwise it queues. */
  canSteer: boolean;
  /** Messages may be edited, regenerated, or switched between versions. */
  canEditHistory: boolean;
  /** The remote Host advertises its own interactive terminal. */
  canTerminal: boolean;
  /** Files are local paths the OS can reveal or open. */
  localFiles: boolean;
};

const ALL_SURFACES: SessionSurfaceGates = {
  remote: false,
  canAttach: true,
  canSelectModel: true,
  canSteer: true,
  canEditHistory: true,
  canTerminal: false,
  localFiles: true,
};

export function isRemoteSession(session: Pick<SessionSummary, "source"> | null | undefined): boolean {
  return session?.source === "remote";
}

export function sessionSurfaceGates(
  session: Pick<SessionSummary, "source" | "capabilities"> | null | undefined,
): SessionSurfaceGates {
  if (!session) return ALL_SURFACES;
  const capabilities = session.capabilities;
  const nativePi = session.source === "pi-native";
  // An absent flag means supported, so local summaries need no new fields.
  const flag = (value: boolean | undefined) => value !== false;
  return {
    remote: isRemoteSession(session),
    canAttach: !nativePi && flag(capabilities?.canAttach) && flag(capabilities?.canMentionFiles),
    canSelectModel: !nativePi && flag(capabilities?.canSelectModel),
    canSteer: flag(capabilities?.canSteer),
    canEditHistory: flag(capabilities?.canEditHistory),
    canTerminal: isRemoteSession(session) && capabilities?.canTerminal === true,
    localFiles: !isRemoteSession(session),
  };
}

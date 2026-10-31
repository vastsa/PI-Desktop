/**
 * What an inline visualization card shows for a reference: a live frame URL
 * or the reason it is unavailable.
 */
import {
  genUiUrl,
  isGenUiSessionId,
  type GenUiErrorCode,
  type GenUiReference,
  type SessionSummary,
} from "@pi-desktop/shared";
import { isRemoteSession } from "../../../lib/remote-session-safety";

export type GenUiUnavailableReason = "outside" | "remote" | GenUiErrorCode;

export type GenUiCardSource =
  | { kind: "live"; url: string }
  | { kind: "unavailable"; reason: GenUiUnavailableReason };

/** The session that renders the message; see `genUiCardSource`. */
export type GenUiOwner = { sessionId: string; remote: boolean };

/**
 * Whether a session's tools write somewhere Main cannot serve: a RACP remote
 * session, or a local session bound to a remote host workspace (whose runtime
 * gets no visualization directory).
 */
export function isGenUiRemoteOwner(
  sessionId: string,
  session: Pick<SessionSummary, "source" | "remoteWorkspace"> | undefined,
): boolean {
  return isRemoteSession({ id: sessionId, source: session?.source }) || Boolean(session?.remoteWorkspace);
}

/**
 * The reference path must still name a file under a visualization directory,
 * but the card always loads the owning session's copy: a forked session gets
 * its own copies (with rewritten paths), and a path naming another session
 * must never reach that session's files. Remote sessions write on their host,
 * which Main cannot serve.
 */
export function genUiCardSource(reference: GenUiReference, owner: GenUiOwner): GenUiCardSource {
  if (owner.remote) return { kind: "unavailable", reason: "remote" };
  if (!reference.location || !isGenUiSessionId(owner.sessionId)) {
    return { kind: "unavailable", reason: "outside" };
  }
  return { kind: "live", url: genUiUrl({ sessionId: owner.sessionId, fileName: reference.location.fileName }) };
}

const REASON_KEYS = {
  outside: "chat.genUi.unavailableOutside",
  remote: "chat.genUi.unavailableRemote",
  "not-found": "chat.genUi.unavailableNotFound",
  "too-large": "chat.genUi.unavailableTooLarge",
  "not-fragment": "chat.genUi.unavailableNotFragment",
  "runtime-unavailable": "chat.genUi.unavailableRuntime",
} as const satisfies Record<GenUiUnavailableReason, string>;

/** i18n key of the reason line under an unavailable card. */
export function genUiUnavailableReasonKey(reason: GenUiUnavailableReason): (typeof REASON_KEYS)[GenUiUnavailableReason] {
  return REASON_KEYS[reason];
}

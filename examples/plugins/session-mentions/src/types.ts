/** Private adapter types, NOT proposed or existing PI-Desktop SDK types. */
export type ReferenceMessage = {
  id?: string;
  role: "user" | "assistant" | "tool" | "system";
  content?: string;
  status?: string;
  parentToolCallId?: string;
  attachments?: readonly unknown[];
  contentTruncated?: boolean;
};

export type SessionQaTurn = { question: string; answer: string };

export type SessionReferenceSnapshot = {
  sessionId: string;
  title: string;
  turns: readonly SessionQaTurn[];
  omittedKnown?: number;
  olderUnread?: boolean;
  readLimitReached?: boolean;
};

export type SessionReferenceSource = {
  id: string;
  title: string;
  messages: readonly ReferenceMessage[];
  hasMoreBefore?: boolean;
  readLimitReached?: boolean;
};

export type SessionReferencePage = {
  id: string;
  title: string;
  messages: readonly ReferenceMessage[];
  messageStart?: number;
  messageEnd?: number;
  hasMoreBefore?: boolean;
};

export type SessionReferenceNotice = {
  sessionId: string;
  title: string;
  includedTurns: number;
  omittedKnown: number;
  olderUnread: boolean;
  readLimitReached: boolean;
};

export type ReferenceIdentity = { path: string; kind?: string };

/** All sources must use one host/session universe and one physical cursor domain. */
export type PageLoader = (
  id: string,
  before: number | undefined,
  signal: AbortSignal,
) => Promise<SessionReferencePage | null>;

import type { PluginSessionMessage } from "./index";

/** A native transcript whose sends are exclusively routed to its owning plugin. */
export type PluginManagedSessionCreateInput = {
  source: string;
  externalId: string;
  title: string;
  projectId?: number | null;
};

/** Finalized external message; retries with the same externalId must match exactly. */
export type PluginManagedMessageInput = {
  sessionId: string;
  externalId: string;
  author?: string;
  message: PluginSessionMessage;
};

/** No attachments, tool grants or executable configuration cross this boundary. */
export type PluginManagedSessionSubmitInput = {
  sessionId: string;
  messageId: string;
  content: string;
};

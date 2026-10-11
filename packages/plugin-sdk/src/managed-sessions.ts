import type { PluginSessionMessage } from "./index";

/** A native transcript whose sends are exclusively routed to its owning plugin. */
export type PluginManagedSessionCreateInput = {
  source: string;
  externalId: string;
  title: string;
  projectId?: number | null;
  /**
   * Compose-time model binding. A managed transcript never runs an agent, so
   * this only decides what the native composer shows; absent values keep the
   * historical NULL binding (the app default model). Changing it later uses
   * `setManagedModel`, never the dangerous `session/configure`.
   */
  providerId?: string;
  modelId?: string;
  thinkingLevel?: string;
};

/** Finalized external message; retries with the same externalId must match exactly. */
export type PluginManagedMessageInput = {
  sessionId: string;
  externalId: string;
  author?: string;
  message: PluginSessionMessage;
};

/**
 * An attachment a managed message carries. Only the descriptor crosses this
 * boundary: the bytes live content-addressed under the host data directory and
 * are read/written through `readManagedAttachment` and the staged upload calls.
 * `inlinePath` records the `@path` text the draft placed between words, so the
 * transcript renders the attachment at that position.
 */
export type PluginManagedAttachment = {
  ref: string;
  name: string;
  kind: "image" | "file";
  mimeType?: string;
  size?: number;
  inlinePath?: string;
};

/**
 * A send from the native composer. Attachments are already stored by the host
 * as content-addressed blobs, so this carries descriptors only — the owning
 * plugin decides what to do with the bytes (ship them to the room, land the
 * ones a peer sent).
 */
export type PluginManagedSessionSubmitInput = {
  sessionId: string;
  messageId: string;
  content: string;
  attachments?: PluginManagedAttachment[];
};

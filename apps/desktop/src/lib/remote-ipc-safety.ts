import { IPC } from "@pi-desktop/shared";
import i18n from "i18next";

const localOnly = new Set<string>([
  IPC.invoke.sessionConfigure, IPC.invoke.sessionFork, IPC.invoke.sessionMoveProject,
  IPC.invoke.sessionReplaceMessages, IPC.invoke.sessionSaveRevision,
  IPC.invoke.sessionListRevisions, IPC.invoke.sessionActivateRevision,
  IPC.invoke.sessionGetScratchPath, IPC.invoke.sessionOpenScratchPath,
  IPC.invoke.agentSteer, IPC.invoke.agentQueuePush, IPC.invoke.agentQueueList,
  IPC.invoke.agentStopSubagents, IPC.invoke.workspaceReviewRollback,
  IPC.invoke.extensionsCommandRun, IPC.invoke.browserNavigate,
  IPC.invoke.fsResolveRef,
]);

/** Defense in depth for keyboard/service callers that bypass disabled controls. */
export function guardRemoteInvocation(channel: string, first: unknown): void {
  const object = first && typeof first === "object" ? first as Record<string, unknown> : undefined;
  const id = typeof first === "string" ? first : object?.sessionId ?? object?.id;
  if (typeof id !== "string" || !id.startsWith("remote:")) return;
  const unsupportedPrompt = channel === IPC.invoke.agentPrompt && (
    (Array.isArray(object?.attachments) && object.attachments.length > 0)
    || object?.truncateFromMessageId !== undefined
  );
  if (localOnly.has(channel) || unsupportedPrompt) {
    throw Object.assign(new Error(i18n.t("remote:readOnly")), { code: "CAPABILITY_UNAVAILABLE" });
  }
}

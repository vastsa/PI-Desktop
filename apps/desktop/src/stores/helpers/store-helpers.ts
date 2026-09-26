import type {
  AgentPromptAttachment,
  AppError,
  Mode,
  PlanProposal,
  PlanningState,
  ProjectWorkspace,
  ProposalKind,
  SessionSummary,
  UiMessage,
} from "@pi-desktop/shared";
import { modeForProposalKind } from "@pi-desktop/shared";
import type { ComposerDraftSnapshot } from "../../lib/composer-smart-stop";
import { normalizeProjectPath } from "../../lib/sidebar-session-groups";
import {
  sessionIsArchived,
  sessionIsPinned,
  type ProjectMeta,
  type SessionMeta,
} from "../../lib/sidebar-preferences";
import { preferredFileWorkPanelTab } from "../../lib/work-panel-tabs";
import type { AppState } from "../app-state";

export function promptAttachmentsFromDraft(
  references: ComposerDraftSnapshot["fileReferences"],
): AgentPromptAttachment[] {
  return references.flatMap((reference) => {
    const kind =
      reference.kind ??
      (/\.(avif|bmp|gif|heic|jpe?g|png|tiff?|webp)$/i.test(reference.path)
        ? "image"
        : "file");
    // Inline chips use tokens for both files and images. Ordinary file chips
    // already serialize to @path text (the model can Read them); only image
    // chips need the structured transport for vision/fallback handling.
    if (reference.token && kind !== "image") return [];
    return [
      {
        path: reference.path,
        name: reference.name,
        kind,
        ...(reference.mimeType ? { mimeType: reference.mimeType } : {}),
      },
    ];
  });
}

export function promptAttachmentsFromMessage(
  attachments: UiMessage["attachments"],
): AgentPromptAttachment[] {
  return (attachments ?? []).map((attachment) => ({
    path: attachment.ref,
    name: attachment.name,
    kind: attachment.kind,
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
  }));
}

export function withoutRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

export function viewingSessionIdForPrompt(
  state: Pick<AppState, "page" | "activeSessionId">,
  sessionId: string,
): string | null {
  return state.page === "chat" && state.activeSessionId === sessionId
    ? sessionId
    : null;
}

export function messageErrorFromUnknown(error: unknown): AppError {
  const value = error as {
    code?: string;
    message?: string;
    retriable?: boolean;
  };
  return {
    code: value?.code || "INTERNAL",
    message:
      error instanceof Error
        ? error.message
        : typeof value?.message === "string"
          ? value.message
          : String(error),
    retriable: value?.retriable === true,
  };
}

export function assistantErrorMessage(error: AppError): UiMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content: "",
    createdAt: new Date().toISOString(),
    status: "error",
    isError: true,
    error,
  };
}

/** Project planning state and proposal kind determine the durable mode shown in the sidebar. */
export function sessionModeForPlanningState(
  state: PlanningState,
  kind: ProposalKind | undefined,
): Mode {
  if (state === "inactive") return "agent";
  return modeForProposalKind(kind ?? "plan");
}

export function openPlanArtifact(
  proposal: PlanProposal,
  openWorkPanelTabForSession: AppState["openWorkPanelTabForSession"],
  pluginViews: AppState["pluginViews"],
) {
  const relativePath = proposal.artifact?.relativePath;
  if (!relativePath) return;
  openWorkPanelTabForSession(
    proposal.sessionId,
    preferredFileWorkPanelTab(relativePath, pluginViews),
  );
}

export function decorateSessions(
  sessions: SessionSummary[],
  meta: Record<string, SessionMeta>,
): SessionSummary[] {
  return sessions.map((session) => ({
    ...session,
    pinned: sessionIsPinned(session.id, meta),
    archived: sessionIsArchived(session.id, meta),
  }));
}

export function promoteProjectPath(paths: string[], rawPath: string): string[] {
  const key = normalizeProjectPath(rawPath);
  if (!key) return paths;
  const withoutPath = paths.filter(
    (path) => normalizeProjectPath(path) !== key,
  );
  return [...withoutPath, rawPath];
}

export function removeProjectPath(paths: string[], rawPath: string): string[] {
  const key = normalizeProjectPath(rawPath);
  return key
    ? paths.filter((path) => normalizeProjectPath(path) !== key)
    : paths;
}

export function upsertWorkspace(
  projects: ProjectWorkspace[],
  workspace: ProjectWorkspace,
): ProjectWorkspace[] {
  const key = normalizeProjectPath(workspace.path);
  if (!key) return projects;
  const index = projects.findIndex((item) => normalizeProjectPath(item.path) === key);
  if (index < 0) return [...projects, workspace];
  const next = projects.slice();
  next[index] = { ...next[index], ...workspace };
  return next;
}

export function withProjectDisplayName(
  workspace: ProjectWorkspace,
  projectMeta: Record<string, ProjectMeta>,
): ProjectWorkspace {
  const key = normalizeProjectPath(workspace.path);
  const name = key ? projectMeta[key]?.name : undefined;
  return name ? { ...workspace, name } : workspace;
}

export function preferencesFromState(state: Pick<
  AppState,
  | "sessionMeta"
  | "projectMeta"
  | "projectSort"
  | "sessionView"
  | "openProjectPaths"
>) {
  return {
    sessionMeta: state.sessionMeta,
    projectMeta: state.projectMeta,
    projectSort: state.projectSort,
    sessionView: state.sessionView,
    openProjectPaths: state.openProjectPaths,
  };
}

/** Append a freshly installed checkpoint, or replace a retried one by id. */
export function withCompactionMark(
  marks: AppState["sessionCompactions"][string] | undefined,
  mark: AppState["sessionCompactions"][string][number],
): AppState["sessionCompactions"][string] {
  const existing = marks?.find((m) => m.id === mark.id);
  const merged = { ...mark, summary: mark.summary ?? existing?.summary };
  return [...(marks ?? []).filter((m) => m.id !== mark.id), merged];
}

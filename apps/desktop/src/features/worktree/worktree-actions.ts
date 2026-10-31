import { WorktreeErrorCodes, type WorktreeProbeResult } from "@pi-desktop/shared";
import type { TFunction } from "i18next";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { useWorktreeUi } from "./worktree-ui-store";

/** Catalog keys for the `WORKTREE_*` codes a user can act on. */
const ERROR_KEYS: Record<string, string> = {
  [WorktreeErrorCodes.NOT_GIT]: "worktree.errors.notGit",
  [WorktreeErrorCodes.NO_COMMITS]: "worktree.errors.noCommits",
  [WorktreeErrorCodes.DETACHED_HEAD]: "worktree.errors.detachedHead",
  [WorktreeErrorCodes.GIT_MISSING]: "worktree.errors.gitMissing",
  [WorktreeErrorCodes.GIT_TOO_OLD]: "worktree.errors.gitTooOld",
  [WorktreeErrorCodes.BRANCH_NAMESPACE_TAKEN]: "worktree.errors.branchNamespaceTaken",
  [WorktreeErrorCodes.BUSY]: "worktree.errors.busy",
  [WorktreeErrorCodes.CHANGED_SINCE_PREVIEW]: "worktree.errors.changedSincePreview",
  [WorktreeErrorCodes.OWNER_BRANCH_CHANGED]: "worktree.errors.ownerBranchChanged",
  [WorktreeErrorCodes.SESSION_BRANCH_CHANGED]: "worktree.errors.sessionBranchChanged",
  [WorktreeErrorCodes.PROJECT_DIRTY]: "worktree.errors.projectDirty",
  [WorktreeErrorCodes.MISSING]: "worktree.errors.missing",
  [WorktreeErrorCodes.COMMIT_FAILED]: "worktree.errors.commitFailed",
  [WorktreeErrorCodes.MOVE_UNSUPPORTED]: "worktree.errors.moveUnsupported",
  [WorktreeErrorCodes.MERGE_FAILED]: "worktree.errors.mergeFailed",
  [WorktreeErrorCodes.PATH_EXISTS]: "worktree.errors.pathExists",
  [WorktreeErrorCodes.NOT_READY]: "worktree.errors.notReady",
  [WorktreeErrorCodes.NOT_ISOLATED]: "worktree.errors.notIsolated",
  [WorktreeErrorCodes.GIT_FAILED]: "worktree.errors.gitFailed",
  [WorktreeErrorCodes.GIT_TIMEOUT]: "worktree.errors.gitTimeout",
  [WorktreeErrorCodes.REMOTE_UNSUPPORTED]: "worktree.errors.remoteUnsupported",
};

/** The `WORKTREE_*` code of an API error; `invoke` stores it as `code`. */
export function worktreeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: unknown; errorCode?: unknown };
  const code = typeof value.code === "string" ? value.code : value.errorCode;
  return typeof code === "string" ? code : undefined;
}

/** Conflicting files reported with `WORKTREE_CONFLICT`. */
export function worktreeConflictFiles(error: unknown): string[] {
  const details = (error as { details?: { files?: unknown } } | null)?.details;
  return Array.isArray(details?.files)
    ? details.files.filter((file): file is string => typeof file === "string")
    : [];
}

/** A localized sentence for a worktree error, or the host's own message. */
export function worktreeErrorMessage(error: unknown, t: TFunction): string {
  const key = ERROR_KEYS[worktreeErrorCode(error) ?? ""];
  if (key) return t(key);
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(error);
}

/** Result of the project-menu probe: still running, answered, or failed. */
export type IsolationProbeState = "checking" | "unknown" | WorktreeProbeResult;

/**
 * Whether "New isolated session" is offered (PRD R6, AC9). Disabled while the
 * probe runs and, with the reason, when the project cannot host a worktree.
 * A failed probe leaves it enabled; creating re-probes and reports the error.
 */
export function isolationAvailability(
  state: IsolationProbeState,
  t: TFunction,
): { disabled: boolean; reason?: string } {
  if (state === "checking") return { disabled: true };
  if (state === "unknown" || state.available) return { disabled: false };
  return {
    disabled: true,
    reason: worktreeErrorMessage({ code: state.errorCode, message: state.message }, t),
  };
}

/** What the merge dialog shows after a failed merge. */
export type MergeFailureState =
  | { phase: "conflict"; files: string[] }
  | { phase: "reload"; notice: string }
  | { phase: "failed"; message: string };

/**
 * Conflicts list their files and stay in the session; a session that changed
 * after the preview is previewed again; anything else is a plain error.
 */
export function mergeFailureState(error: unknown, t: TFunction): MergeFailureState {
  const code = worktreeErrorCode(error);
  if (code === WorktreeErrorCodes.CONFLICT) {
    return { phase: "conflict", files: worktreeConflictFiles(error) };
  }
  if (code === WorktreeErrorCodes.CHANGED_SINCE_PREVIEW) {
    return { phase: "reload", notice: t("worktree.errors.changedSincePreview") };
  }
  return { phase: "failed", message: worktreeErrorMessage(error, t) };
}

/**
 * "Sync from project": bring the project's new commits into the session's
 * worktree. A conflict stays in the session and is listed; the sidebar is
 * refreshed either way so the badge follows.
 */
export async function syncIsolatedSession(sessionId: string, t: TFunction): Promise<void> {
  const { showToast, refreshSessions } = useAppStore.getState();
  try {
    const outcome = await api.syncWorktree(sessionId);
    if (outcome.result === "synced") {
      showToast(t("worktree.sync.success", { count: outcome.commits }), { variant: "success" });
    } else {
      showToast(t("worktree.sync.upToDate"), { variant: "info" });
    }
  } catch (error) {
    const files =
      worktreeErrorCode(error) === WorktreeErrorCodes.CONFLICT ? worktreeConflictFiles(error) : [];
    showToast(
      files.length > 0
        ? t("worktree.sync.conflict", { files: files.join(", ") })
        : worktreeErrorMessage(error, t),
      { variant: "error" },
    );
  } finally {
    void refreshSessions();
    useWorktreeUi.getState().refreshBehind();
  }
}

/**
 * "New isolated session": check that the project can host a worktree, say so
 * when uncommitted project changes stay behind (PRD R2b), then create the
 * session. Failures are reported as toasts in the user's language.
 */
export async function createIsolatedSession(projectPath: string, t: TFunction): Promise<void> {
  const { newSession, showToast } = useAppStore.getState();
  try {
    const probe = await api.probeWorktree(projectPath);
    if (!probe.available) {
      showToast(worktreeErrorMessage({ code: probe.errorCode, message: probe.message }, t), {
        variant: "error",
      });
      return;
    }
    if (probe.uncommittedChanges) {
      showToast(t("worktree.uncommittedNotIncluded"), { variant: "info" });
    }
    await newSession({ projectPath, isolated: true });
  } catch (error) {
    showToast(worktreeErrorMessage(error, t), { variant: "error" });
  }
}

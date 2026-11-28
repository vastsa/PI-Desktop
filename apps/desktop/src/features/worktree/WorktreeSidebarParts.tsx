import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionWorktreeSummary, WorktreePendingWork } from "@pi-desktop/shared";
import {
  IconBranch,
  IconFileText,
  IconFolderOpen,
  IconPullRequest,
  IconRefresh,
  IconWrench,
} from "../../components/icons";
import { Badge } from "../../components/ui";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import {
  sidebarMenuAction,
  type SidebarMenuActionItem,
} from "../../lib/sidebar-menu";
import { WorktreeMergeDialog } from "./WorktreeMergeDialog";
import { WorktreeSetupCommandDialog, WorktreeSetupLogDialog } from "./WorktreeSetupDialogs";
import {
  createIsolatedSession,
  isolationAvailability,
  type IsolationProbeState,
  syncIsolatedSession,
  worktreeErrorMessage,
} from "./worktree-actions";
import { WorktreeBehindMarker } from "./WorktreeBehind";
import { useWorktreeUi } from "./worktree-ui-store";
/** Session-row badge for an isolated session (PRD R3). */
export function WorktreeBadge({
  worktree,
  sessionId,
}: {
  worktree?: SessionWorktreeSummary;
  /** Shows the "behind the project" marker when given. */
  sessionId?: string;
}) {
  const { t } = useTranslation();
  if (!worktree) return null;
  const [tone, label] =
    worktree.status === "conflict"
      ? (["warning", t("worktree.badge.conflict")] as const)
      : worktree.status === "missing"
        ? (["error", t("worktree.badge.missing")] as const)
        : worktree.setupStatus === "failed"
          ? (["warning", t("worktree.badge.setupFailed")] as const)
          : (["neutral", t("worktree.badge.isolated")] as const);
  return (
    <>
      <span
        className="thread-item-worktree"
        title={t("worktree.badge.title", { branch: worktree.branch })}
        data-worktree-status={worktree.status}
      >
        <Badge tone={tone}>{label}</Badge>
      </span>
      {/* A conflicted session cannot sync until it resolves the conflict. */}
      {sessionId && worktree.status !== "missing" && worktree.status !== "conflict" ? (
        <WorktreeBehindMarker sessionId={sessionId} />
      ) : null}
    </>
  );
}

/** Project-menu items: create an isolated session, edit the setup command. */
/**
 * Project-menu rows for isolation: start an isolated session, or edit the
 * setup command. Returned as menu data so the sidebar renders them inside its
 * own "Git" group next to the other repository actions.
 */
export function useWorktreeProjectMenuItems({
  projectPath,
  projectName,
  onDone,
}: {
  projectPath: string;
  projectName: string;
  onDone: () => void;
}): SidebarMenuActionItem[] {
  const { t } = useTranslation();
  const open = useWorktreeUi((s) => s.open);
  const reasonId = useId();
  const [probe, setProbe] = useState<{
    projectPath: string;
    state: IsolationProbeState;
  }>({ projectPath: "", state: "checking" });
  // Probe only while a project menu is open. A new project starts disabled
  // until its own answer arrives; the previous project's answer never leaks.
  useEffect(() => {
    if (!projectPath) {
      setProbe({ projectPath: "", state: "checking" });
      return;
    }
    let current = true;
    setProbe({ projectPath, state: "checking" });
    api
      .probeWorktree(projectPath)
      .then((result) => current && setProbe({ projectPath, state: result }))
      .catch(() => current && setProbe({ projectPath, state: "unknown" }));
    return () => {
      current = false;
    };
  }, [projectPath]);
  const probeState = probe.projectPath === projectPath ? probe.state : "checking";
  const { disabled, reason } = isolationAvailability(probeState, t);
  return [
    sidebarMenuAction({
      id: "new-isolated-session",
      label: t("worktree.newIsolatedSession"),
      icon: <IconBranch size={14} />,
      disabled,
      busy: probeState === "checking",
      describedBy: reason ? reasonId : undefined,
      title: reason,
      onSelect: () => {
        onDone();
        void createIsolatedSession(projectPath, t);
      },
    }),
    sidebarMenuAction({
      id: "worktree-setup-command",
      label: t("worktree.setupCommand.menu"),
      icon: <IconWrench size={14} />,
      title: t("worktree.setupCommand.menu"),
      onSelect: () => {
        onDone();
        open({ kind: "setupCommand", projectPath, projectName });
      },
    }),
  ];
}

/**
 * A session's isolation rows, when the session has a worktree at all. The
 * sidebar places them in its "Git" group, so no other session pays for them.
 */
export function useWorktreeSessionMenuItems({
  sessionId,
  title,
  worktree,
  running,
  onDone,
}: {
  sessionId: string;
  title: string;
  worktree?: SessionWorktreeSummary;
  running: boolean;
  onDone: () => void;
}): SidebarMenuActionItem[] {
  const { t } = useTranslation();
  const open = useWorktreeUi((s) => s.open);
  // A conflicted session resolves first; syncing again would only report
  // the same conflict.
  const conflicted = worktree?.status === "conflict";
  const syncable = Boolean(worktree) && worktree?.status !== "missing" && !conflicted;
  // Project commits the session lacks, counted when the menu opens; `-1`
  // when the count failed (syncing still reports the reason).
  const [behind, setBehind] = useState<number | null>(null);
  useEffect(() => {
    if (!sessionId || !syncable) return;
    let current = true;
    setBehind(null);
    api
      .getWorktreeBehind(sessionId)
      .then((count) => {
        if (!current) return;
        setBehind(count);
        useWorktreeUi.getState().setBehindFor(sessionId, count);
      })
      .catch(() => current && setBehind(-1));
    return () => {
      current = false;
    };
  }, [sessionId, syncable]);
  if (!worktree) return [];
  const missing = worktree.status === "missing";
  return [
    sidebarMenuAction({
      id: "worktree-merge",
      label: t("worktree.merge.menu"),
      icon: <IconPullRequest size={14} />,
      disabled: running || missing,
      onSelect: () => {
        onDone();
        open({ kind: "merge", sessionId, title });
      },
    }),
    sidebarMenuAction({
      id: "worktree-sync",
      label:
        syncable && behind !== null && behind > 0
          ? t("worktree.sync.menuBehind", { count: behind })
          : t("worktree.sync.menu"),
      icon: <IconRefresh size={14} />,
      disabled: running || !syncable || behind === null || behind === 0,
      busy: behind === null && syncable,
      title: conflicted
        ? t("worktree.sync.resolveFirst")
        : behind === 0
          ? t("worktree.sync.upToDate")
          : undefined,
      onSelect: () => {
        onDone();
        void syncIsolatedSession(sessionId, t);
      },
    }),
    sidebarMenuAction({
      id: "worktree-reveal",
      label: t("worktree.reveal"),
      icon: <IconFolderOpen size={14} />,
      disabled: missing,
      onSelect: () => {
        onDone();
        void api.revealWorktree(sessionId).catch((error: unknown) =>
          useAppStore
            .getState()
            .showToast(worktreeErrorMessage(error, t), { variant: "error" }),
        );
      },
    }),
    ...(worktree.setupStatus && worktree.setupStatus !== "none"
      ? [
          sidebarMenuAction({
            id: "worktree-setup-log",
            label: t("worktree.setupLog.menu"),
            icon: <IconFileText size={14} />,
            onSelect: () => {
              onDone();
              open({ kind: "setupLog", sessionId, title });
            },
          }),
        ]
      : []),
  ];
}

/**
 * The text of the pre-delete warning for an isolated session: deleting removes
 * its worktree and branch, so unmerged work is named before the second click
 * (PRD R5). `null` when nothing would be lost.
 */
export function useWorktreeDeleteLossText(sessionId: string): string | null {
  const { t } = useTranslation();
  const [pending, setPending] = useState<WorktreePendingWork | null>(null);
  useEffect(() => {
    if (!sessionId) {
      setPending(null);
      return;
    }
    let alive = true;
    api
      .getWorktreePendingWork(sessionId)
      .then((result) => alive && setPending(result))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [sessionId]);
  if (!pending || (pending.unmergedCommits === 0 && !pending.uncommittedChanges)) {
    return null;
  }
  return t("worktree.deleteLoss");
}

/** Renders the open worktree dialog. Mounted once by the sidebar. */
export function WorktreeDialogs() {
  const dialog = useWorktreeUi((s) => s.dialog);
  const close = useWorktreeUi((s) => s.close);
  if (!dialog) return null;
  if (dialog.kind === "merge") {
    return <WorktreeMergeDialog sessionId={dialog.sessionId} title={dialog.title} onClose={close} />;
  }
  if (dialog.kind === "setupLog") {
    return <WorktreeSetupLogDialog sessionId={dialog.sessionId} title={dialog.title} onClose={close} />;
  }
  return (
    <WorktreeSetupCommandDialog
      projectPath={dialog.projectPath}
      projectName={dialog.projectName}
      onClose={close}
    />
  );
}

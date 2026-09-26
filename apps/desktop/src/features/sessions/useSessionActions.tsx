import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { normalizeProjectPath, sessionArchived } from "../../lib/sidebar-session-groups";
import { useArmedDelete } from "../../hooks/use-armed-delete";
import { SessionRenameDialog } from "../../components/SessionRenameDialog";
import type { useSessionNavigation } from "./useSessionNavigation";

export function useSessionActions({
  projectEntries,
  temporarySessions,
  closeMenus,
  afterPin,
}: Pick<ReturnType<typeof useSessionNavigation>, "projectEntries" | "temporarySessions"> & {
  closeMenus: (restoreFocus?: boolean) => void;
  afterPin: () => void;
}) {
  const { t } = useTranslation();
  const [renameFor, setRenameFor] = useState<SessionSummary | null>(null);
  const { armed: armedDelete, setArmed: setArmedDelete } = useArmedDelete();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessionMeta = useAppStore((s) => s.sessionMeta);
  const restoreSession = useAppStore((s) => s.restoreSession);
  const archiveSessionAction = useAppStore((s) => s.archiveSession);
  const newSession = useAppStore((s) => s.newSession);
  const deleteSessionAction = useAppStore((s) => s.deleteSession);
  const forkSessionAction = useAppStore((s) => s.forkSession);
  const renameSession = useAppStore((s) => s.renameSession);
  const showToast = useAppStore((s) => s.showToast);
  const reportError = (error: unknown) =>
    showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
  const focusComposer = () =>
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus(),
    );
  const selectProjectSession = async (session: SessionSummary) => {
    try {
      await useAppStore.getState().selectSession(session.id);
      focusComposer();
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  };
  const toggleSessionPin = (session: SessionSummary) => {
    useAppStore.getState().toggleSessionPinned(session.id);
    closeMenus(false);
    afterPin();
  };
  const rename = (session: SessionSummary) => {
    closeMenus(false);
    setRenameFor(session);
  };
  const archiveSession = async (session: SessionSummary) => {
    const archived = sessionArchived(session, sessionMeta[session.id]);
    const wasActive = activeSessionId === session.id;
    const next =
      !archived && wasActive
        ? session.projectPath
          ? projectEntries
              .find((entry) => entry.key === normalizeProjectPath(session.projectPath))
              ?.sessions.find(
                (item) => item.id !== session.id && !sessionArchived(item, sessionMeta[item.id]),
              )
          : temporarySessions.find(
              (item) => item.id !== session.id && !sessionArchived(item, sessionMeta[item.id]),
            )
        : undefined;
    try {
      closeMenus();
      if (archived) {
        restoreSession(session.id);
        return;
      }
      if (wasActive && next) {
        if (!(await selectProjectSession(next))) return;
        archiveSessionAction(session.id);
        return;
      }
      if (wasActive) {
        // Archive first so an empty active slot is not reused as its own
        // replacement. Restore it if creating the fallback slot fails.
        archiveSessionAction(session.id);
        try {
          await newSession({ projectPath: session.projectPath ?? null });
        } catch (error) {
          restoreSession(session.id);
          throw error;
        }
        return;
      }
      archiveSessionAction(session.id);
    } catch (error) {
      reportError(error);
    }
  };

  const deleteSession = async (session: SessionSummary) => {
    closeMenus();
    const wasActive = activeSessionId === session.id;
    const sameScope = session.projectPath
      ? (projectEntries.find((entry) => entry.key === normalizeProjectPath(session.projectPath))
          ?.sessions ?? [])
      : temporarySessions;
    const next = wasActive
      ? (sameScope.find(
          (item) => item.id !== session.id && !sessionArchived(item, sessionMeta[item.id]),
        ) ??
        projectEntries
          .flatMap((entry) => entry.sessions)
          .find((item) => item.id !== session.id && !sessionArchived(item, sessionMeta[item.id])))
      : undefined;
    try {
      await deleteSessionAction(session.id);
      if (wasActive) {
        if (next) await selectProjectSession(next);
        else await newSession({ projectPath: session.projectPath ?? null });
      }
    } catch (error) {
      reportError(error);
    }
  };

  /**
   * Two-step delete for one row's menu item. The first click arms the item and
   * relabels it; only the second click runs the delete, and the arm expires on
   * its own. The menu stays open between the two clicks.
   */
  const requestDeleteSession = (session: SessionSummary) => {
    if (armedDelete !== session.id) {
      setArmedDelete(session.id);
      return;
    }
    setArmedDelete(null);
    void deleteSession(session);
  };

  const forkSession = async (session: SessionSummary) => {
    closeMenus(false);
    try {
      await forkSessionAction(session.id);
      focusComposer();
    } catch (error) {
      reportError(error);
    }
  };

  const copyConversationId = async (session: SessionSummary) => {
    try {
      await navigator.clipboard.writeText(session.id);
      showToast(t("chat.copied"));
    } catch (error) {
      reportError(error);
    }
    closeMenus();
  };

  const openSessionPath = async (session: SessionSummary) => {
    closeMenus(false);
    try {
      await api.openSessionScratchPath(session.id);
    } catch (error) {
      reportError(error);
    }
  };

  return {
    rename,
    toggleSessionPin,
    archiveSession,
    forkSession,
    copyConversationId,
    openSessionPath,
    requestDeleteSession,
    armedDelete,
    resetDelete: () => setArmedDelete(null),
    renameDialog: renameFor ? (
      <SessionRenameDialog
        session={renameFor}
        onClose={() => setRenameFor(null)}
        onSave={(title) => renameSession(renameFor.id, title)}
        onError={reportError}
      />
    ) : null,
  };
}

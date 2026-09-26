import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { sessionPinned, sessionArchived } from "../../lib/sidebar-session-groups";
import { cx } from "../../components/ui";
import {
  IconPencil,
  IconPin,
  IconArchive,
  IconArchiveRestore,
  IconBranch,
  IconCopy,
  IconFolder,
  IconX,
} from "../../components/icons";
import type { useSessionActions } from "./useSessionActions";

export function SessionActionItems({
  session,
  actions,
  menuFirstItemRef,
}: {
  session: SessionSummary;
  actions: ReturnType<typeof useSessionActions>;
  menuFirstItemRef?: Ref<HTMLButtonElement>;
}) {
  const { t } = useTranslation();
  const sessionMeta = useAppStore((s) => s.sessionMeta);
  const runningSessions = useAppStore((s) => s.runningSessions);
  const settings = useAppStore((s) => s.settings);
  const {
    rename,
    toggleSessionPin,
    archiveSession,
    forkSession,
    copyConversationId,
    openSessionPath,
    requestDeleteSession,
    armedDelete,
  } = actions;
  return (
    <>
      {session.source !== "pi-native" ? (
        <button
          ref={menuFirstItemRef}
          type="button"
          role="menuitem"
          data-action="rename-session"
          onClick={() => {
            rename(session);
          }}
        >
          <IconPencil size={14} />
          {t("nav.renameTask", { defaultValue: "Rename task" })}
        </button>
      ) : null}
      <button
        ref={session.source === "pi-native" ? menuFirstItemRef : undefined}
        type="button"
        role="menuitem"
        data-action="toggle-session-pin"
        onClick={() => toggleSessionPin(session)}
      >
        <IconPin size={14} />
        {sessionPinned(session, sessionMeta[session.id])
          ? t("nav.unpinTask", { defaultValue: "Unpin" })
          : t("nav.pinTask", { defaultValue: "Pin" })}
      </button>
      <button
        type="button"
        role="menuitem"
        data-action="toggle-session-archive"
        onClick={() => void archiveSession(session)}
      >
        {sessionArchived(session, sessionMeta[session.id]) ? (
          <IconArchiveRestore size={14} />
        ) : (
          <IconArchive size={14} />
        )}
        {sessionArchived(session, sessionMeta[session.id])
          ? t("nav.restoreTask", { defaultValue: "Restore" })
          : t("nav.archiveTask", { defaultValue: "Archive" })}
      </button>
      {session.source !== "pi-native" ? (
        <button
          type="button"
          role="menuitem"
          data-action="fork-session"
          disabled={Boolean(runningSessions[session.id])}
          onClick={() => void forkSession(session)}
        >
          <IconBranch size={14} />
          {t("nav.createBranch")}
        </button>
      ) : null}
      {settings?.developerMode === true ? (
        <>
          <button
            type="button"
            role="menuitem"
            data-action="copy-conversation-id"
            onClick={() => void copyConversationId(session)}
          >
            <IconCopy size={14} />
            {t("nav.copyConversationId")}
          </button>
          <button
            type="button"
            role="menuitem"
            data-action="open-session-path"
            onClick={() => void openSessionPath(session)}
          >
            <IconFolder size={14} />
            {t("nav.openSessionPath")}
          </button>
        </>
      ) : null}
      {session.source !== "pi-native" ? (
        <button
          type="button"
          role="menuitem"
          className={cx("danger", armedDelete === session.id && "is-armed")}
          data-action="delete-session"
          data-armed={armedDelete === session.id ? "true" : undefined}
          onClick={() => requestDeleteSession(session)}
        >
          <IconX size={14} />
          {armedDelete === session.id
            ? t("nav.deleteTaskConfirm", { defaultValue: "Delete?" })
            : t("nav.deleteTask", { defaultValue: "Delete" })}
        </button>
      ) : null}
    </>
  );
}

import type { Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { GlobalPermissionMode, Mode } from "@pi-desktop/shared";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { TooltipButton } from "../../../components/ui";
import { IconCheck, IconChevronDown } from "../../../components/icons";
import { PERMISSION_MODE_I18N_KEYS } from "../../../lib/permission-mode-labels";
import type { ApprovalReviewer, SessionApprovalReviewer } from "@pi-desktop/shared";
import { SessionPermissionGrants } from "./SessionPermissionGrants";
import { SessionPermissionReviewHistory } from "./SessionPermissionReviewHistory";

/** Controlled permission UI shared by conversations and task drafts. */
export function ComposerPermissionPicker({t, mode, composerPermissionMode,
  effectiveReviewer, sessionReviewer, hasActiveSession,
  sessionId,
  permissionOpen, setPermissionOpen, controlsBlocked, onCloseOtherMenus, onSelect, onSelectReviewer,
}: {
  t: TFunction;
  mode: Mode;
  composerPermissionMode: GlobalPermissionMode;
  effectiveReviewer: ApprovalReviewer;
  sessionReviewer: SessionApprovalReviewer;
  hasActiveSession: boolean;
  sessionId?: string;
  permissionOpen: boolean;
  setPermissionOpen: Dispatch<SetStateAction<boolean>>;
  controlsBlocked: boolean;
  onCloseOtherMenus: () => void;
  onSelect: (mode: GlobalPermissionMode) => void | Promise<void>;
  onSelectReviewer: (reviewer: SessionApprovalReviewer) => void | Promise<void>;
}) {
  const reviewerLabel = composerPermissionMode === "auto" || mode === "goal"
    ? t("chat.permissionNoReview")
    : effectiveReviewer === "auto_review" ? t("settings.reviewByModel") : t("settings.reviewByUser");
  const pickerLabel = `${t("chat.permissionMode")} · ${reviewerLabel}`;
  return (
        <AnchoredMenu
          className="composer-permission"
          open={permissionOpen && mode !== "goal"}
          onClose={() => setPermissionOpen(false)}
          menuClassName="composer-permission-menu"
          label={t("chat.permissionMode")}
          role="menu"
          align="start"
          side="top"
          trigger={(ref) => (
            <TooltipButton
              ref={ref}
              type="button"
              className={`icon-btn mode-chip ${permissionOpen ? "active" : ""}`}
              tooltip={
                mode === "goal"
                  ? `${t("chat.permissionMode")} · ${t("goal.autoWarning")}`
                  : mode === "plan" && composerPermissionMode === "auto"
                    ? `${t("chat.permissionMode")} · ${t("plan.autoWarning")}`
                  : pickerLabel
              }
              ariaLabel={
                mode === "goal"
                  ? `${t("chat.permissionMode")} · ${t("goal.autoWarning")}`
                  : mode === "plan" && composerPermissionMode === "auto"
                    ? `${t("chat.permissionMode")} · ${t("plan.autoWarning")}`
                    : pickerLabel
              }
              aria-haspopup={mode === "goal" ? undefined : "menu"}
              aria-expanded={mode === "goal" ? false : permissionOpen}
              disabled={controlsBlocked || mode === "goal"}
              onClick={() => {
                onCloseOtherMenus();
                setPermissionOpen((open) => !open);
              }}
            >
              <span className="text-sm">
                {t(PERMISSION_MODE_I18N_KEYS[composerPermissionMode])}
                <span className="text-text-muted"> · {reviewerLabel}</span>
              </span>
              <IconChevronDown size={12} />
            </TooltipButton>
          )}
        >
          {(["ask", "accept-edits", "auto"] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="menuitemradio"
              aria-checked={composerPermissionMode === candidate}
              disabled={controlsBlocked}
              className={`composer-plus-item ${composerPermissionMode === candidate ? "active" : ""}`}
              onClick={async () => {
                setPermissionOpen(false);
                await onSelect(candidate);
              }}
            >
              <span className="flex-1 text-left">
                {t(PERMISSION_MODE_I18N_KEYS[candidate])}
              </span>
              {composerPermissionMode === candidate ? <IconCheck size={13} /> : null}
            </button>
          ))}
          {hasActiveSession && mode !== "goal" && composerPermissionMode !== "auto" ? (
            <>
              <span className="composer-plus-item" role="presentation">{t("settings.approvalReviewer")}</span>
              {(["inherit", "user", "auto_review"] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  role="menuitemradio"
                  aria-checked={sessionReviewer === candidate}
                  disabled={controlsBlocked}
                  className={`composer-plus-item ${sessionReviewer === candidate ? "active" : ""}`}
                  onClick={async () => {
                    setPermissionOpen(false);
                    await onSelectReviewer(candidate);
                  }}
                >
                  <span className="flex-1 text-left">
                    {candidate === "inherit" ? t("chat.reviewInherit")
                      : candidate === "user" ? t("settings.reviewByUser") : t("settings.reviewByModel")}
                  </span>
                  {sessionReviewer === candidate ? <IconCheck size={13} /> : null}
                </button>
              ))}
            </>
          ) : null}
          {sessionId && hasActiveSession ? <SessionPermissionGrants key={sessionId} sessionId={sessionId} open={permissionOpen} /> : null}
          {sessionId && hasActiveSession ? <SessionPermissionReviewHistory key={sessionId} sessionId={sessionId} open={permissionOpen} /> : null}
        </AnchoredMenu>
  );
}

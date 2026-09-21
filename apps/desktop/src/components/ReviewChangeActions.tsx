import { useTranslation } from "react-i18next";
import type { ReviewChange } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { toolWorkPanelTab } from "../lib/work-panel-tabs";
import { focusReviewChange } from "../lib/review-navigation";
import { useOpenPreviewTarget } from "../hooks/use-preview-target";
import { IconDiff, IconExternal } from "./icons";

export function ReviewChangeActions({ change }: { change: ReviewChange }) {
  const { t } = useTranslation();
  const openTarget = useOpenPreviewTarget();
  const review = () => {
    const state = useAppStore.getState();
    if (!state.activeSessionId || !state.workspace?.path) return;
    focusReviewChange(
      state.activeSessionId,
      state.workspace.path,
      change.snapshotId,
    );
    state.openWorkPanelTab(toolWorkPanelTab("review"));
  };
  return (
    <>
      <button
        type="button"
        className="review-change-rollback review-navigate"
        onClick={review}
      >
        <IconDiff size={13} />
        {t("panel.review.feedback.review")}
      </button>
      <button
        type="button"
        className="review-change-rollback review-open-file"
        onClick={() => openTarget({ kind: "file", path: change.path })}
      >
        <IconExternal size={13} />
        {t("panel.review.feedback.open")}
      </button>
    </>
  );
}

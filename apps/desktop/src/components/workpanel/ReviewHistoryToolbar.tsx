import type { ReviewContextLines } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { ContextMenu, useContextMenu, type ContextMenuItem } from "../ContextMenu";
import { Select, TooltipButton } from "../ui";
import { IconMore } from "../icons";

export function ReviewHistoryToolbar({ history, onHistory, count, additions, deletions, context, onContext, wrap, onWrap, anyOpen, disclosureDisabled, onToggleAll }: {
  history: boolean; onHistory: (history: boolean) => void;
  count: number; additions: number; deletions: number;
  context: ReviewContextLines; onContext: (context: ReviewContextLines) => void;
  wrap: boolean; onWrap: () => void;
  anyOpen: boolean; disclosureDisabled: boolean; onToggleAll: () => void;
}) {
  const { t } = useTranslation();
  const settingsMenu = useContextMenu();
  const items: ContextMenuItem[] = [
    { id: "review-wrap", label: t("panel.review.wordWrap"), checked: wrap, onSelect: onWrap },
    { id: "review-context", label: t("panel.review.contextDisplay"), submenu: ([1, 3, 5] as const).map(lines => ({
      id: `review-context-${lines}`, label: t("panel.review.contextLineOption", { count: lines }), checked: context === lines, onSelect: () => onContext(lines),
    })) },
    { id: "review-toggle-all", label: t(anyOpen ? "panel.review.collapseAll" : "panel.review.expandAll"), disabled: disclosureDisabled, onSelect: onToggleAll },
  ];
  return <>
    <div className="review-toolbar review-round-toolbar">
      <Select className="review-select review-round-scope" aria-label={t("panel.review.reviewScope")} value={history ? "history" : "last"}
        onChange={event => { settingsMenu.closeContextMenu(); onHistory(event.target.value === "history"); }}>
        <option value="last">{t("panel.review.previousRound")}</option>
        <option value="history">{t("panel.review.historyMode")}</option>
      </Select>
      <span className="review-summary">{t("chat.toolChipFiles", { count })}</span>
      <span className="diff-counts review-toolbar-counts" aria-label={t("chat.reviewChangeCounts", { additions, deletions })}>
        <span className="diff-count-add">+{additions}</span><span className="diff-count-del">−{deletions}</span>
      </span>
      <TooltipButton className="icon-btn review-settings-button" tooltip={t("panel.review.reviewSettings")} aria-haspopup="menu" aria-expanded={!!settingsMenu.contextMenu} onClick={event => {
        settingsMenu.openContextMenu(event, { label: t("panel.review.reviewSettings"), anchor: "bottom-end", items });
      }}><IconMore size={16} /></TooltipButton>
    </div>
    <ContextMenu state={settingsMenu.contextMenu && { ...settingsMenu.contextMenu, items }} onClose={settingsMenu.closeContextMenu} />
  </>;
}

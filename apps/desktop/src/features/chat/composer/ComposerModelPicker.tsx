import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { ComposerModelList } from "./ComposerModelList";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { IconBot, IconChevronDown } from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import type { useComposerModelMenu } from "./hooks/useComposerModelMenu";
import { ThinkingLevelSlider } from "./ThinkingLevelSlider";

type ModelMenuController = ReturnType<typeof useComposerModelMenu>;

export type ComposerModelPickerProps = {
  t: TFunction;
  controller: ModelMenuController;
  modelLabel: string;
  thinkingLabel: string;
  thinkingLevel: string;
  selectedProviderId?: string;
  selectedModelId?: string;
  controlsBlocked: boolean;
  onCloseOtherMenus: () => void;
  rootActions?: ReactNode;
};

/** Model/reasoning picker with its keyboard and focus contract intact. */
export function ComposerModelPicker({
  t,
  controller,
  modelLabel,
  thinkingLabel,
  thinkingLevel,
  selectedProviderId,
  selectedModelId,
  controlsBlocked,
  onCloseOtherMenus,
  rootActions,
}: ComposerModelPickerProps) {
  const {
    open,
    setOpen,
    otherModelsExpanded,
    setOtherModelsExpanded,
    hasOtherModels,
    query,
    setQuery,
    modelHighlight,
    setModelHighlight,
    modelSearchRef,
    modelListRef,
    modelGroups,
    recentEntries,
    thinkingMenuLevels,
    selectModel,
    commitThinkingLevel,
    onMenuKeyDown,
  } = controller;

  return (
    <AnchoredMenu
      className="composer-model-thinking"
      open={open}
      onClose={() => setOpen(false)}
      menuClassName="composer-model-menu composer-model-thinking-menu"
      label={`${t("chat.model")} ${t("chat.reasoningLevel")}`}
      role="menu"
      align="end"
      side="top"
      initialFocus="input"
      onMenuKeyDown={onMenuKeyDown}
      trigger={(ref) => (
        <TooltipButton
          ref={ref}
          type="button"
          className={`icon-btn composer-model-thinking-chip ${open ? "active" : ""}`}
          tooltip={`${modelLabel} · ${t("chat.reasoningLevel")}: ${thinkingLabel}`}
          ariaLabel={`${t("chat.model")}: ${modelLabel}. ${t("chat.reasoningLevel")}: ${thinkingLabel}`}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={controlsBlocked}
          onClick={() => {
            onCloseOtherMenus();
            if (!open) {
              setOtherModelsExpanded(false);
              setQuery("");
              setModelHighlight(-1);
            }
            setOpen((current) => !current);
          }}
        >
          <span className="composer-model-thinking-icon" aria-hidden="true">
            <IconBot size={14} />
          </span>
          <span className="composer-model-thinking-model">{modelLabel}</span>
          {thinkingLevel !== "off" ? (
            <span className="composer-model-thinking-level">{thinkingLabel}</span>
          ) : null}
          <IconChevronDown size={12} aria-hidden="true" className="composer-model-thinking-chevron" />
        </TooltipButton>
      )}
    >
      <div className="composer-menu-root" onMouseMove={() => setModelHighlight(-1)} onMouseLeave={() => setModelHighlight(-1)}>
        {rootActions}
        <ComposerModelList
          t={t} query={query} setQuery={setQuery}
          modelSearchRef={modelSearchRef} modelListRef={modelListRef}
          modelGroups={modelGroups} modelHighlight={modelHighlight}
          recentEntries={recentEntries} hasOtherModels={hasOtherModels}
          otherModelsExpanded={otherModelsExpanded}
          setOtherModelsExpanded={setOtherModelsExpanded}
          setModelHighlight={setModelHighlight} selectModel={selectModel}
          selectedProviderId={selectedProviderId} selectedModelId={selectedModelId}
        />
        {thinkingMenuLevels.length > 1 ? (
          <ThinkingLevelSlider
            key={`${selectedProviderId}:${selectedModelId}:${thinkingMenuLevels.join("|")}`}
            levels={thinkingMenuLevels}
            level={thinkingLevel}
            label={t("chat.reasoningLevel")}
            commit={commitThinkingLevel}
          />
        ) : null}
      </div>
    </AnchoredMenu>
  );
}

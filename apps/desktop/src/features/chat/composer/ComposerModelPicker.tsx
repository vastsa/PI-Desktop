import { useEffect, useState, type CSSProperties } from "react";
import type { TFunction } from "i18next";
import { formatTokenCount, modelIdsMatch } from "@pi-desktop/shared";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import {
  IconBot,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconSearch,
  IconSparkles,
} from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { composerModelBadges } from "../../../lib/composer-models";
import type { useComposerModelMenu } from "./hooks/useComposerModelMenu";

type ModelMenuController = ReturnType<typeof useComposerModelMenu>;

/**
 * Keys the native range input must own while focused. The menu root ignores
 * arrows, but stopping propagation keeps the keys unambiguous — they adjust
 * the level, never drive menu navigation — no matter where focus lands.
 */
const THINKING_SLIDER_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Enter",
]);

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
}: ComposerModelPickerProps) {
  const {
    open,
    setOpen,
    view,
    query,
    setQuery,
    modelHighlight,
    setModelHighlight,
    thinkingHighlight,
    setThinkingHighlight,
    rootMenuRef,
    modelSearchRef,
    modelListRef,
    thinkingListRef,
    modelGroups,
    flatModels,
    thinkingMenuLevels,
    showView,
    selectModel,
    commitThinkingLevel,
    selectThinkingLevel,
    onMenuKeyDown,
  } = controller;

  // Slider geometry: one stop per available level, with the fill carried as
  // a CSS custom property so the accent track can follow the native input.
  const thinkingSliderIndex = Math.max(
    thinkingMenuLevels.findIndex((level) => level === thinkingLevel),
    0,
  );
  // Local drag lead: the native input follows the pointer or arrow key
  // immediately while the store confirmation lands, so a controlled value
  // never snaps back mid-drag. The lead clears once the store confirms.
  const thinkingLevelsKey = thinkingMenuLevels.join("|");
  const [dragThinkingIndex, setDragThinkingIndex] = useState<number | null>(null);
  useEffect(() => {
    setDragThinkingIndex(null);
  }, [thinkingLevelsKey]);
  useEffect(() => {
    if (dragThinkingIndex === null) return;
    if (thinkingMenuLevels[dragThinkingIndex] === thinkingLevel) {
      setDragThinkingIndex(null);
    }
  }, [dragThinkingIndex, thinkingLevel, thinkingLevelsKey, thinkingMenuLevels]);
  const thinkingSliderValue = dragThinkingIndex ?? thinkingSliderIndex;
  const thinkingSliderPercent =
    thinkingMenuLevels.length > 1
      ? (thinkingSliderValue / (thinkingMenuLevels.length - 1)) * 100
      : 0;

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
      initialFocus="none"
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
              showView("root");
              setQuery("");
              setModelHighlight(-1);
              setThinkingHighlight(-1);
            }
            setOpen((current) => !current);
          }}
        >
          <span className="composer-model-thinking-icon" aria-hidden="true">
            <IconBot size={14} />
          </span>
          <span className="composer-model-thinking-model">{modelLabel}</span>
          {thinkingLevel !== "off" ? (
            <>
              <span className="composer-model-thinking-dot" aria-hidden="true">·</span>
              <span className="composer-model-thinking-level">{thinkingLabel}</span>
            </>
          ) : null}
          <IconChevronDown size={12} aria-hidden="true" className="composer-model-thinking-chevron" />
        </TooltipButton>
      )}
    >
      {view === "root" ? (
        <div className="composer-menu-root" ref={rootMenuRef}>
          <button
            type="button"
            className="composer-menu-entry"
            role="menuitem"
            aria-haspopup="menu"
            onClick={() => showView("model")}
          >
            <IconBot size={14} aria-hidden="true" />
            <span className="composer-menu-entry-label">{t("chat.model")}</span>
            <span className="composer-menu-entry-value" title={modelLabel}>{modelLabel}</span>
            <IconChevronRight size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="composer-menu-entry"
            role="menuitem"
            aria-haspopup="menu"
            onClick={() => showView("thinking")}
          >
            <IconSparkles size={14} aria-hidden="true" />
            <span className="composer-menu-entry-label">{t("chat.reasoningLevel")}</span>
            <span className="composer-menu-entry-value">{thinkingLabel}</span>
            <IconChevronRight size={14} aria-hidden="true" />
          </button>
          {/* The slider sits directly under the Reasoning level entry
              (issue #417): one drag adjusts the level without entering the
              submenu, while the entry itself opens the classic radio list. */}
          {thinkingMenuLevels.length > 1 ? (
            <div className="composer-thinking-slider">
              <input
                type="range"
                className="composer-thinking-range"
                min={0}
                max={thinkingMenuLevels.length - 1}
                step={1}
                value={thinkingSliderValue}
                aria-label={t("chat.reasoningLevel")}
                aria-valuetext={thinkingMenuLevels[thinkingSliderValue] ?? thinkingLevel}
                style={
                  {
                    "--composer-thinking-progress": `${thinkingSliderPercent}%`,
                  } as CSSProperties
                }
                onChange={(event) => {
                  const index = Number(event.target.value);
                  setDragThinkingIndex(index);
                  const level = thinkingMenuLevels[index];
                  if (level && level !== thinkingLevel) void commitThinkingLevel(level);
                }}
                onKeyDown={(event) => {
                  if (THINKING_SLIDER_KEYS.has(event.key)) event.stopPropagation();
                }}
              />
              <div className="composer-thinking-ticks" aria-hidden="true">
                {thinkingMenuLevels.map((level, index) => (
                  <button
                    key={level}
                    type="button"
                    tabIndex={-1}
                    className={`composer-thinking-tick ${thinkingSliderValue === index ? "active" : ""}`}
                    title={level}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setDragThinkingIndex(index);
                      if (level !== thinkingLevel) void commitThinkingLevel(level);
                    }}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <button
            type="button"
            className="composer-menu-back"
            role="menuitem"
            onClick={() => showView("root")}
          >
            <IconChevronLeft size={14} aria-hidden="true" />
            <span>{view === "model" ? t("chat.model") : t("chat.reasoningLevel")}</span>
          </button>
          <div className="composer-menu-separator" />
          {view === "model" ? (
            <>
              <label className="composer-model-search">
                <IconSearch size={13} aria-hidden="true" />
                <span className="sr-only">{t("chat.searchModels")}</span>
                <input
                  ref={modelSearchRef}
                  type="text"
                  value={query}
                  placeholder={t("chat.searchModels")}
                  aria-label={t("chat.searchModels")}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <div className="composer-model-list" ref={modelListRef}>
                {(() => {
                  let flatIndex = 0;
                  return modelGroups.map((group) => (
                    <div
                      key={group.provider.id}
                      className="composer-model-group"
                      role="group"
                      aria-label={group.providerDisplayName}
                    >
                      <div className="composer-model-group-label">{group.providerDisplayName}</div>
                      {group.models.map((model) => {
                        const index = flatIndex++;
                        const active =
                          selectedProviderId === group.provider.id &&
                          modelIdsMatch(selectedModelId ?? "", model.modelId);
                        const optionTitle = model.displayName || model.modelId;
                        return (
                          <button
                            key={`${group.provider.id}:${model.modelId}`}
                            type="button"
                            data-model-index={index}
                            title={optionTitle}
                            className={`composer-plus-item composer-model-option ${active ? "active" : ""} ${modelHighlight === index ? "kb-active" : ""}`}
                            role="menuitemradio"
                            aria-checked={active}
                            onMouseMove={() => setModelHighlight(index)}
                            onClick={() => void selectModel(group.provider, model.modelId)}
                          >
                            <span className="composer-model-option-main">
                              <span className="truncate">{optionTitle}</span>
                              <span className="composer-model-option-meta">
                                {composerModelBadges(model, group.provider).map((badge) => (
                                  <span
                                    key={badge}
                                    className="composer-model-option-badge"
                                    title={t(badge === "reasoning" ? "chat.modelBadgeReasoning" : "chat.modelBadgeVision")}
                                  >
                                    {t(badge === "reasoning" ? "chat.modelBadgeReasoning" : "chat.modelBadgeVision")}
                                  </span>
                                ))}
                                {model.contextWindow ? (
                                  <span className="composer-model-option-ctx">
                                    {formatTokenCount(model.contextWindow)}
                                  </span>
                                ) : null}
                              </span>
                            </span>
                            {active ? <IconCheck size={14} className="composer-model-check" aria-hidden="true" /> : null}
                          </button>
                        );
                      })}
                    </div>
                  ));
                })()}
                {flatModels.length === 0 ? (
                  <div className="composer-model-empty">{t("chat.noModelResults")}</div>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <div className="composer-thinking-heading">
                {t("chat.reasoningSupportedBy", { model: modelLabel })}
              </div>
              <div className="composer-thinking-list" ref={thinkingListRef}>
                {thinkingMenuLevels.map((level, index) => (
                  <button
                    key={level}
                    type="button"
                    data-thinking-index={index}
                    className={`composer-plus-item ${thinkingLevel === level ? "active" : ""} ${thinkingHighlight === index ? "kb-active" : ""}`}
                    role="menuitemradio"
                    aria-checked={thinkingLevel === level}
                    onMouseMove={() => setThinkingHighlight(index)}
                    onClick={() => void selectThinkingLevel(level)}
                  >
                    <span className="flex-1">{level}</span>
                    {thinkingLevel === level ? <IconCheck size={14} className="composer-model-check" aria-hidden="true" /> : null}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </AnchoredMenu>
  );
}

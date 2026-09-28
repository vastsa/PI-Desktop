import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { ComposerModelList } from "./ComposerModelList";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import {
  IconBot,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconTerminal,
} from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { useAppStore } from "../../../stores/app-store";
import { externalAgentForSession } from "../../../lib/session-backend";
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
    view,
    query,
    setQuery,
    modelHighlight,
    setModelHighlight,
    rootMenuRef,
    modelSearchRef,
    modelListRef,
    modelGroups,
    thinkingMenuLevels,
    showView,
    selectModel,
    commitThinkingLevel,
    onMenuKeyDown,
  } = controller;

  // A session on an agent row is run by a program on this machine, not by the
  // built-in agent, and that program edits the project with its own tools. The
  // chip says so where a prompt is about to be sent: the icon swaps because at
  // narrow widths this chip collapses to the icon alone, and the tooltip
  // carries the sentence for everyone else.
  const providers = useAppStore((s) => s.providers);
  const externalAgent = externalAgentForSession(selectedProviderId, providers);
  const backendNote = externalAgent
    ? t("chat.externalAgentRuns", { command: externalAgent.command })
    : "";
  const description = [backendNote, modelLabel, `${t("chat.reasoningLevel")}: ${thinkingLabel}`]
    .filter(Boolean)
    .join(" · ");

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
          tooltip={description}
          ariaLabel={`${t("chat.model")}: ${description}`}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={controlsBlocked}
          onClick={() => {
            onCloseOtherMenus();
            if (!open) {
              showView("root");
              setQuery("");
              setModelHighlight(-1);
            }
            setOpen((current) => !current);
          }}
        >
          <span
            className={`composer-model-thinking-icon${externalAgent ? " is-external-agent" : ""}`}
            aria-hidden="true"
          >
            {externalAgent ? <IconTerminal size={14} /> : <IconBot size={14} />}
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
          {rootActions}
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
          {/* The level is one drag away on the slider below (issue #417): the
              menu has no separate reasoning view left to open. */}
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
      ) : (
        <>
          <button
            type="button"
            className="composer-menu-back"
            role="menuitem"
            onClick={() => showView("root")}
          >
            <IconChevronLeft size={14} aria-hidden="true" />
            <span>{t("chat.model")}</span>
          </button>
          <div className="composer-menu-separator" />
          <ComposerModelList
            t={t} query={query} setQuery={setQuery}
            modelSearchRef={modelSearchRef} modelListRef={modelListRef}
            modelGroups={modelGroups} modelHighlight={modelHighlight}
            setModelHighlight={setModelHighlight} selectModel={selectModel}
            selectedProviderId={selectedProviderId} selectedModelId={selectedModelId}
          />
        </>
      )}
    </AnchoredMenu>
  );
}

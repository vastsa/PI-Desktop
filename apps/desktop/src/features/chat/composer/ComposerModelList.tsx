import { formatTokenCount, type ModelInfo, type ProviderPublic } from "@pi-desktop/shared";
import type { TFunction } from "i18next";
import type { CSSProperties, RefObject } from "react";
import { IconCheck, IconEye, IconSearch, IconSettings, IconSparkles, IconX } from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import {
  composerModelBadges,
  composerModelBinding,
  composerModelDisplayName,
  sameComposerModelId,
} from "../../../lib/composer-models";
import { providerDisplayName } from "../../../lib/provider-display";
import type { ComposerModelSection } from "./hooks/useComposerModelMenu";

export type ComposerModelGroup = {
  provider: ProviderPublic;
  providerDisplayName: string;
  models: ModelInfo[];
};

type ModelRowProps = {
  t: TFunction;
  provider: ProviderPublic;
  model: ModelInfo;
  index: number;
  highlighted: boolean;
  active: boolean;
  /** Rows outside a provider section name their source instead of capabilities. */
  showProvider: boolean;
  selectModel: (provider: ProviderPublic, modelId: string) => void | Promise<void>;
};

function ModelRow({ t, provider, model, index, highlighted, active, showProvider, selectModel }: ModelRowProps) {
  const optionTitle = model.modelId;
  const alias = composerModelBinding(provider, model.modelId)?.alias?.trim();
  const optionDisplayName = composerModelDisplayName(provider, model.modelId);
  return (
    <button
      type="button"
      data-model-index={index}
      title={optionTitle}
      className={`composer-plus-item composer-model-option ${active ? "active" : ""} ${highlighted ? "kb-active" : ""}`}
      role="menuitemradio"
      aria-checked={active}
      onClick={() => void selectModel(provider, model.modelId)}
    >
      <span className="composer-model-option-main">
        {/*
          One label per row, never both: the name the user set wins over the
          catalog's, and an alias carries its own tone so which one is on
          screen stays visible. The wire id remains the row's title.
        */}
        <span className={`composer-model-label ${alias ? "is-alias" : ""}`}>
          {alias || optionDisplayName}
        </span>
        <span className="composer-model-option-meta">
          {showProvider ? (
            <span className="composer-model-option-provider">{providerDisplayName(provider)}</span>
          ) : (
            <>
              {composerModelBadges(model, provider).map((badge) => {
                const badgeLabel = t(
                  badge === "reasoning" ? "chat.modelBadgeReasoning" : "chat.modelBadgeVision",
                );
                return (
                  <span
                    key={badge}
                    className="composer-model-option-badge"
                    title={badgeLabel}
                    aria-label={badgeLabel}
                    role="img"
                  >
                    {badge === "reasoning" ? (
                      <IconSparkles size={12} aria-hidden="true" />
                    ) : (
                      <IconEye size={12} aria-hidden="true" />
                    )}
                  </span>
                );
              })}
              {model.contextWindow ? (
                <span className="composer-model-option-ctx">{formatTokenCount(model.contextWindow)}</span>
              ) : null}
            </>
          )}
        </span>
      </span>
      <span className="composer-model-check-slot" aria-hidden="true">
        {active ? <IconCheck size={13} className="composer-model-check" /> : null}
      </span>
    </button>
  );
}

/**
 * Source rail + model list. Every configured model is at most one click away:
 * the rail picks a source (recent or a provider), search spans all sources.
 * Selection is owned by the caller, never by this view.
 */
export function ComposerModelList({
  t, query, setQuery, modelSearchRef, modelListRef, modelGroups,
  modelHighlight, setModelHighlight, selectedProviderId, selectedModelId, selectModel,
  recentEntries, sections, activeSection, sectionStep, selectSection, showSectionRail, searching, paneRows,
  onOpenModelSettings,
}: {
  onOpenModelSettings?: () => void;
  paneRows: number;
  recentEntries: Array<{ provider: ProviderPublic; model: ModelInfo }>;
  sections: ComposerModelSection[];
  activeSection: string | null;
  /** Direction of the last rail move; 0 before the first move. */
  sectionStep: number;
  selectSection: (id: string) => void;
  showSectionRail: boolean;
  searching: boolean;
  t: TFunction;
  query: string;
  setQuery: (query: string) => void;
  modelSearchRef: RefObject<HTMLInputElement | null>;
  modelListRef: RefObject<HTMLDivElement | null>;
  modelGroups: ComposerModelGroup[];
  modelHighlight: number;
  setModelHighlight: (index: number) => void;
  selectedProviderId?: string;
  selectedModelId?: string;
  selectModel: (provider: ProviderPublic, modelId: string) => void | Promise<void>;
}) {
  const isActive = (provider: ProviderPublic, model: ModelInfo) =>
    selectedProviderId === provider.id && sameComposerModelId(selectedModelId ?? "", model.modelId);
  const flatCount = recentEntries.length + modelGroups.reduce((sum, group) => sum + group.models.length, 0);
  const railIndex = sections.findIndex((section) => section.id === activeSection);
  let flatIndex = recentEntries.length;
  return <>
    <label className="composer-model-search">
      <IconSearch size={14} aria-hidden="true" />
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
        onBlur={() => setModelHighlight(-1)}
      />
      {query ? (
        <button
          type="button"
          className="composer-model-search-clear"
          aria-label={t("settings.clearSearch")}
          // Keep focus in the field so typing continues after the clear.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setQuery("");
            setModelHighlight(-1);
            modelSearchRef.current?.focus();
          }}
        >
          <IconX size={11} aria-hidden="true" />
        </button>
      ) : null}
      {onOpenModelSettings ? (
        <TooltipButton
          type="button"
          className="composer-model-settings"
          tooltip={t("chat.manageModels")}
          ariaLabel={t("chat.manageModels")}
          onClick={onOpenModelSettings}
        >
          <IconSettings size={14} aria-hidden="true" />
        </TooltipButton>
      ) : null}
    </label>
    <div
      className="composer-model-body"
      data-rail={showSectionRail ? "true" : undefined}
      style={{ "--model-pane-rows": paneRows } as CSSProperties}
    >
      {showSectionRail ? (
        <div className="composer-model-rail" role="group" aria-label={t("chat.modelSources")}>
          <span
            className="composer-model-rail-indicator"
            aria-hidden="true"
            data-hidden={railIndex < 0 ? "true" : undefined}
            style={{ "--rail-index": Math.max(railIndex, 0) } as CSSProperties}
          />
          {sections.map((section) => {
            const label = section.kind === "recent" ? t("chat.recentModels") : section.label;
            const current = section.id === activeSection;
            return (
              <button
                key={section.id}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                title={label}
                data-empty={searching && (section.kind === "recent" || section.count === 0) ? "true" : undefined}
                className={`composer-model-rail-item ${current ? "active" : ""}`}
                onClick={() => selectSection(section.id)}
              >
                <span className="composer-model-rail-label">{label}</span>
                {section.kind === "provider" ? (
                  <span className="composer-model-rail-count">{section.count}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="composer-model-list" ref={modelListRef}>
        {/* Keyed by source so a rail move replays the entry motion once. */}
        <div
          key={activeSection ?? "search"}
          className="composer-model-pane"
          data-step={sectionStep === 0 ? undefined : sectionStep < 0 ? "back" : "forward"}
        >
          {recentEntries.length > 0 ? (
            <div className="composer-model-group" role="group" aria-label={t("chat.recentModels")}>
              {recentEntries.map(({ provider, model }, index) => (
                <ModelRow
                  key={`${provider.id}:${model.modelId}`}
                  t={t} provider={provider} model={model} index={index}
                  highlighted={modelHighlight === index}
                  active={isActive(provider, model)}
                  showProvider selectModel={selectModel}
                />
              ))}
            </div>
          ) : null}
          {modelGroups.map((group) => (
            <div
              key={group.provider.id}
              className="composer-model-group"
              role="group"
              aria-label={group.providerDisplayName}
            >
              {searching ? (
                <div className="composer-model-group-label">{group.providerDisplayName}</div>
              ) : null}
              {group.models.map((model) => {
                const index = flatIndex++;
                return (
                  <ModelRow
                    key={`${group.provider.id}:${model.modelId}`}
                    t={t} provider={group.provider} model={model} index={index}
                    highlighted={modelHighlight === index}
                    active={isActive(group.provider, model)}
                    showProvider={false} selectModel={selectModel}
                  />
                );
              })}
            </div>
          ))}
          {flatCount === 0 ? (
            <div className="composer-model-empty">{t("chat.noModelResults")}</div>
          ) : null}
        </div>
      </div>
    </div>
  </>;
}

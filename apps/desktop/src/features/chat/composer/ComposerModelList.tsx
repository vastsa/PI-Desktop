import { formatTokenCount, type ModelInfo, type ProviderPublic } from "@pi-desktop/shared";
import type { TFunction } from "i18next";
import type { RefObject } from "react";
import { IconCheck, IconEye, IconSearch, IconSparkles } from "../../../components/icons";
import {
  composerModelBadges,
  composerModelBinding,
  composerModelDisplayName,
  sameComposerModelId,
} from "../../../lib/composer-models";

export type ComposerModelGroup = {
  provider: ProviderPublic;
  providerDisplayName: string;
  models: ModelInfo[];
};

/** Shared model list. Selection is owned by the caller, never by this view. */
export function ComposerModelList({
  t, query, setQuery, modelSearchRef, modelListRef, modelGroups,
  modelHighlight, setModelHighlight, selectedProviderId, selectedModelId, selectModel,
}: {
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
  const flatModels = modelGroups.flatMap(group => group.models);
  return <>
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
                          sameComposerModelId(selectedModelId ?? "", model.modelId);
                        const optionTitle = model.modelId;
                        const alias = composerModelBinding(
                          group.provider,
                          model.modelId,
                        )?.alias?.trim();
                        const optionDisplayName = composerModelDisplayName(
                          group.provider,
                          model.modelId,
                          model.displayName,
                        );
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
                              {/*
                                One label per row, never both: the name the user
                                set wins over the catalog's, and an alias carries
                                its own tone so which one is on screen stays
                                visible. The wire id remains the row's title, so
                                identity is still one hover away.
                              */}
                              <span
                                className={`composer-model-label ${alias ? "is-alias" : ""}`}
                              >
                                {alias || optionDisplayName}
                              </span>
                              <span className="composer-model-option-meta">
                                {composerModelBadges(model, group.provider).map((badge) => {
                                  const badgeLabel = t(
                                    badge === "reasoning"
                                      ? "chat.modelBadgeReasoning"
                                      : "chat.modelBadgeVision",
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
  </>;
}

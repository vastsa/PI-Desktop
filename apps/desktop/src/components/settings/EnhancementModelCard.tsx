/**
 * Enhancement model and reasoning rows (ADR 0121).
 *
 * Which model rewrites the Composer draft, and with how much reasoning, live
 * on the Settings → AI Prompt enhancement card, as rows below the custom-template
 * switch. They are rows rather than a second card so the template, model, and
 * reasoning for the same action share one heading.
 *
 * The picker reuses the default-model anchored menu so Settings offers one kind
 * of model picker, and the reasoning row reuses the shared settings menu select.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  THINKING_LEVELS,
  canonicalThinkingLevel,
  type AppSettings,
  type ThinkingLevel,
} from "@pi-desktop/shared";
import {
  thinkingLevelForProvider,
  thinkingProviderForModel,
} from "../../features/chat/composer/model";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { providerDisplayName, providerSearchText } from "../../lib/provider-display";
import { sameComposerModelId } from "../../lib/composer-models";
import { Button, Input, cx } from "../ui";
import { IconCheck, IconChevronDown, IconSearch } from "../icons";
import { AnchoredMenu } from "./AnchoredMenu";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { SettingsRow } from "../../features/settings/primitives";
import { defaultModelOptions } from "./default-model";
import {
  groupSubagentModelChoices,
  subagentModelChoices,
  subagentModelOrphanPin,
  subagentModelSelectValue,
} from "./subagent-models";

export function EnhancementModelCard() {
  const { t } = useTranslation();
  const providers = useAppStore((state) => state.providers);
  const providerModels = useAppStore((state) => state.providerModels);
  const settings = useAppStore((state) => state.settings);
  const showToast = useAppStore((state) => state.showToast);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");

  const choices = useMemo(() => subagentModelChoices(providers), [providers]);
  const groups = useMemo(() => groupSubagentModelChoices(choices), [choices]);
  const pinnedValue = useMemo(() => {
    if (!settings?.promptEnhancementProviderId || !settings?.promptEnhancementModelId) return "";
    return subagentModelSelectValue(
      `${settings.promptEnhancementProviderId}/${settings.promptEnhancementModelId}`,
      choices,
    );
  }, [choices, settings?.promptEnhancementProviderId, settings?.promptEnhancementModelId]);
  const orphanPin = useMemo(
    () => subagentModelOrphanPin(pinnedValue, choices),
    [pinnedValue, choices],
  );
  // The menu lists runnable providers, same set the Composer would offer.
  const options = useMemo(
    () => defaultModelOptions(providers.filter((provider) => provider.enabled)),
    [providers],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(({ provider, modelId }) =>
      `${providerSearchText(provider)} ${modelId}`.toLowerCase().includes(needle),
    );
  }, [options, query]);

  const pinnedProviderId = settings?.promptEnhancementProviderId ?? "";
  const pinnedModelId = settings?.promptEnhancementModelId ?? "";
  const pinnedProvider =
    providers.find((provider) => provider.id === pinnedProviderId) ?? null;
  /**
   * The repository resolves a model's real reasoning ladder from its binding's
   * `thinkingLevels`, then the live catalog, then the provider default. Reusing
   * it keeps this row honest: a model without reasoning offers only `off`
   * instead of the full canonical list, which is what this row showed before.
   */
  const reasoningProvider = useMemo(() => {
    if (!pinnedProviderId || !pinnedModelId) return null;
    return thinkingProviderForModel(
      pinnedProvider,
      pinnedModelId,
      providerModels[pinnedProviderId],
    );
  }, [pinnedProvider, providerModels, pinnedProviderId, pinnedModelId]);
  const reasoningLevels = useMemo(
    () =>
      reasoningProvider?.supportsReasoning
        ? THINKING_LEVELS.filter((level) =>
            (reasoningProvider.supportedThinkingLevels ?? []).includes(level),
          )
        : [],
    [reasoningProvider],
  );
  // A pinned model defines the ladder; with no pin the request follows the
  // session's model, whose ladder is not knowable here, so offer the full list.
  // A model without reasoning still lists `off` so the closed trigger does not
  // show the raw id, and the row is disabled.
  const noReasoning =
    Boolean(reasoningProvider) && reasoningProvider?.supportsReasoning !== true;
  const levelOptions = noReasoning
    ? (["off"] as ThinkingLevel[])
    : reasoningProvider
      ? reasoningLevels.length > 0
        ? reasoningLevels
        : (["off"] as ThinkingLevel[])
      : [...THINKING_LEVELS];
  const storedReasoning = settings?.promptEnhancementThinkingLevel ?? "off";
  const reasoning = useMemo(() => {
    if (!reasoningProvider) return storedReasoning;
    return canonicalThinkingLevel(thinkingLevelForProvider(reasoningProvider, storedReasoning));
  }, [reasoningProvider, storedReasoning]);

  // Every hook runs before this: `settings` arrives after the first bootstrap,
  // so an early return above them would change the hook count between renders.
  if (!settings) return null;

  const save = async (patch: Partial<AppSettings>) => {
    const next = { ...settings, ...patch };
    try {
      await api.setSettings(next);
      useAppStore.setState({ settings: next });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    }
  };

  const pickModel = async (providerId: string, modelId: string) => {
    // Switching model can change the reasoning ladder (a model without
    // reasoning has none), so re-clamp the stored level onto the new model.
    const nextProvider = providerId
      ? thinkingProviderForModel(
          providers.find((provider) => provider.id === providerId) ?? null,
          modelId,
          providerModels[providerId],
        )
      : null;
    const stored = settings.promptEnhancementThinkingLevel ?? "off";
    await save({
      promptEnhancementProviderId: providerId,
      promptEnhancementModelId: modelId,
      promptEnhancementThinkingLevel: nextProvider
        ? canonicalThinkingLevel(thinkingLevelForProvider(nextProvider, stored))
        : stored,
    });
    setPicking(false);
  };

  return (
    <>
        <SettingsRow
          title={t("settings.promptEnhancementModel")}
          detail={
            settings.promptEnhancementProviderId && settings.promptEnhancementModelId ? (
              <span className="model-default-value">
                <span className="model-default-provider">
                  {pinnedProvider
                    ? providerDisplayName(pinnedProvider)
                    : settings.promptEnhancementProviderId}
                </span>
                <span className="model-default-sep" aria-hidden>
                  ·
                </span>
                <span className="model-default-model font-mono">
                  {settings.promptEnhancementModelId}
                </span>
                {!pinnedProvider || orphanPin ? (
                  <span className="model-default-empty">
                    {" "}
                    {t("settings.promptEnhancementModelUnavailable")}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="model-default-empty">
                {t("settings.promptEnhancementModelFollow")}
              </span>
            )
          }
        >
          <AnchoredMenu
            className="model-default-anchor"
            open={picking}
            onClose={() => setPicking(false)}
            menuClassName="model-default-menu"
            label={t("settings.promptEnhancementModel")}
            align="end"
            trigger={(ref) => (
              <Button
                ref={ref}
                className="settings-text-action model-default-trigger"
                variant="ghost"
                disabled={groups.length === 0 && !orphanPin}
                onClick={() => {
                  setQuery("");
                  setPicking((current) => !current);
                }}
                aria-haspopup="listbox"
                aria-expanded={picking}
              >
                {t("settings.changeDefaultModel")}
                <IconChevronDown
                  className="model-default-trigger-chevron"
                  size={13}
                  aria-hidden
                />
              </Button>
            )}
          >
            <div className="model-default-search">
              <IconSearch size={14} aria-hidden />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("settings.defaultModelSearch")}
                aria-label={t("settings.defaultModelSearch")}
                autoFocus
              />
            </div>
            <div className="model-default-results" role="presentation">
              {visible.length === 0 ? (
                <div className="model-default-no-results">{t("settings.noModelMatches")}</div>
              ) : null}
              <ul className="model-default-list">
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected={!settings.promptEnhancementProviderId}
                    aria-label={t("settings.promptEnhancementModelFollow")}
                    className={cx(
                      "model-default-option",
                      !settings.promptEnhancementProviderId && "is-current",
                    )}
                    onClick={() => void pickModel("", "")}
                  >
                    <span className="model-default-option-check" aria-hidden>
                      {!settings.promptEnhancementProviderId ? <IconCheck size={12} /> : null}
                    </span>
                    <span className="model-default-option-model">
                      {t("settings.promptEnhancementModelFollow")}
                    </span>
                  </button>
                </li>
                {visible.map(({ provider, modelId }, index) => {
                  const isCurrent =
                    settings.promptEnhancementProviderId === provider.id &&
                    sameComposerModelId(settings.promptEnhancementModelId ?? "", modelId);
                  const previous = visible[index - 1];
                  const startsGroup = !previous || previous.provider.id !== provider.id;
                  return (
                    <li key={`${provider.id}:${modelId}`}>
                      {startsGroup ? (
                        <div
                          className={cx(
                            "model-default-provider-group",
                            index > 0 && "has-divider",
                          )}
                        >
                          {providerDisplayName(provider)}
                        </div>
                      ) : null}
                      <button
                        type="button"
                        role="option"
                        aria-selected={isCurrent}
                        aria-label={`${providerDisplayName(provider)} · ${modelId}`}
                        className={cx("model-default-option", isCurrent && "is-current")}
                        onClick={() => void pickModel(provider.id, modelId)}
                      >
                        <span className="model-default-option-check" aria-hidden>
                          {isCurrent ? <IconCheck size={12} /> : null}
                        </span>
                        <span className="model-default-option-model font-mono">{modelId}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </AnchoredMenu>
        </SettingsRow>

        <SettingsRow
          title={t("settings.promptEnhancementThinking")}
          description={t("settings.promptEnhancementThinkingDesc")}
        >
          <SettingsMenuSelect
            label={t("settings.promptEnhancementThinking")}
            value={reasoning}
            disabled={noReasoning}
            options={levelOptions.map((level) => ({
              id: level,
              label: level === "off" ? t("settings.promptEnhancementThinkingOff") : level,
            }))}
            onChange={(id) =>
              void save({
                // Clamp through the same resolver the row displays, so the value
                // stored is always one this model can run.
                promptEnhancementThinkingLevel: reasoningProvider
                  ? canonicalThinkingLevel(
                      thinkingLevelForProvider(reasoningProvider, id as ThinkingLevel),
                    )
                  : (id as ThinkingLevel),
              })
            }
          />
        </SettingsRow>
    </>
  );
}

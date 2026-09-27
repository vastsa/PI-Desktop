/** Fixed platform connection details; the API token is stored once per row. */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AI_PLATFORM_BASE_URL, type CatalogApiStyle } from "@pi-desktop/shared";
import { Field, PasswordInput } from "../ui";
import { IconCheck } from "../icons";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { ServiceMonogram } from "./ServiceMonogram";
import { ModelsFetchErrorMessage } from "./ModelsFetchErrorMessage";
import { canRecommendFrom } from "./recommended-models";
import { isPlatformApiStyle, PLATFORM_API_STYLES } from "./service-catalog";
import type { ProviderModelsState } from "./useProviderModels";
import { API_STYLE_LABEL_KEYS } from "./provider-api-style";

/**
 * One line that answers "did it work?" for the credentials above it. Silent
 * while nothing can be asked yet, then connecting, connected with a count, or
 * the classified failure the model picker would show.
 */
export function ConnectionStatus({
  active,
  discovery,
  named,
}: {
  /** Whether the form holds enough to contact the service. */
  active: boolean;
  discovery: ProviderModelsState;
  named: boolean;
}) {
  const { t } = useTranslation();
  let content: ReactNode;
  let tone: "hint" | "ok" | "error" = "hint";
  if (!active) {
    content = t(named ? "settings.connectionKeyHint" : "settings.connectionUrlHint");
  } else if (
    discovery.status === "idle" ||
    discovery.status === "loading" ||
    discovery.source === "cache"
  ) {
    content = t("settings.connectionChecking");
  } else if (discovery.status === "ready" && !discovery.error) {
    tone = "ok";
    content = t(
      discovery.source === "remote" ? "settings.connectionReady" : "settings.connectionCatalog",
      { count: discovery.models.length },
    );
  } else if (canRecommendFrom(discovery, named)) {
    // A named vendor without a model-list route: the key was not refused.
    tone = "ok";
    content = t("settings.connectionNoModelList", { count: discovery.models.length });
  } else {
    return <ModelsFetchErrorMessage error={discovery.error} variant="status" />;
  }
  return (
    <div className={`provider-connection-status is-${tone}`} aria-live="polite">
      {tone === "ok" ? <IconCheck size={12} aria-hidden /> : null}
      <span>{content}</span>
    </div>
  );
}

export type ProviderConnectionFieldsProps = {
  editing: boolean;
  saving: boolean;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  apiStyle: CatalogApiStyle;
  onApiStyleChange: (value: CatalogApiStyle) => void;
  status: ReactNode;
};

export function ProviderConnectionFields({
  editing, saving, apiKey, onApiKeyChange, apiStyle, onApiStyleChange, status,
}: ProviderConnectionFieldsProps) {
  const { t } = useTranslation();
  return (
    <div className="provider-setup-fields is-named">
      <div className="provider-setup-field-row provider-setup-service-row is-named">
        <div className="block space-y-1.5">
          <div className="text-sm text-text-secondary">{t("settings.service")}</div>
          <div className="provider-service-chip">
            <ServiceMonogram name={t("settings.presetAiPlatform")} />
            <span className="provider-service-chip-copy">
              <span className="provider-service-chip-name">{t("settings.presetAiPlatform")}</span>
              <span className="provider-service-chip-host">{AI_PLATFORM_BASE_URL}</span>
            </span>
          </div>
          <p className="text-sm text-text-secondary">{t("settings.platformCredentialHint")}</p>
        </div>
        <div className="provider-setup-key">
          <Field label={t("settings.apiKey")} hint={editing ? t("settings.apiKeyKeepHint") : undefined}>
            <PasswordInput
              value={apiKey}
              placeholder="sk-…"
              className="font-mono text-sm-plus"
              autoComplete="off"
              autoFocus
              disabled={saving}
              showLabel={t("settings.platformShowToken")}
              hideLabel={t("settings.platformHideToken")}
              onChange={(event) => onApiKeyChange(event.target.value)}
            />
          </Field>
          {status}
        </div>
      </div>
      <Field label={t("settings.apiStyle")}>
        <SettingsMenuSelect
          fullWidth
          label={t("settings.apiStyle")}
          value={apiStyle}
          disabled={saving}
          onChange={(value) => { if (isPlatformApiStyle(value)) onApiStyleChange(value); }}
          options={PLATFORM_API_STYLES.map((style) => ({
            id: style,
            label: t(API_STYLE_LABEL_KEYS[style]),
          }))}
        />
      </Field>
    </div>
  );
}

/** Configure the optional Jev System One classifier from Add service. */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  JEV_SYSTEM_ONE_API_STYLE,
  normalizeJevBaseUrl,
  normalizeJevClassifierBinding,
  normalizeJevModelId,
  type JevClassifierBinding,
} from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { Button, Field, Input, PasswordInput } from "../ui";
import { addJevService } from "./jev-config";
import { appJevConfigDeps, useJevKeyStatus } from "./jev-app-config";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import {
  CUSTOM_PROVIDER_SETUP_API_STYLES,
  PROVIDER_SETUP_API_STYLE_LABEL_KEYS,
  type ProviderSetupApiStyle,
} from "./provider-api-style";
import { endpointLabel } from "./service-catalog";
import { ServiceMonogram } from "./ServiceMonogram";

export type JevServiceFormProps = {
  onClose: () => void;
  onConfigured: () => void;
  binding: JevClassifierBinding;
  apiKey?: string;
  onApiKeyChange?: (value: string) => void;
  custom?: boolean;
  onBindingChange?: (binding: JevClassifierBinding) => void;
  onApiStyleChange?: (style: ProviderSetupApiStyle) => void;
  onChangeService?: () => void;
};

export function JevServiceForm({
  onClose,
  onConfigured,
  apiKey,
  onApiKeyChange,
  binding,
  custom = false,
  onBindingChange,
  onApiStyleChange,
  onChangeService,
}: JevServiceFormProps) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [checking, setChecking] = useState(false);
  const [keyStatus] = useJevKeyStatus();
  const [localKeyDraft, setLocalKeyDraft] = useState("");
  const aborted = useRef<AbortController | null>(null);
  const configured = keyStatus === "configured";
  const normalized = normalizeJevClassifierBinding(binding);
  const validBaseUrl = normalizeJevBaseUrl(binding.baseUrl) !== undefined;
  const validModelId = normalizeJevModelId(binding.modelId) !== undefined;

  useEffect(() => () => aborted.current?.abort(), []);

  const keyDraft = apiKey ?? localKeyDraft;
  const updateKey = onApiKeyChange ?? setLocalKeyDraft;
  const statusText = configured
    ? t("settings.jevKeyConfigured")
    : keyStatus === "unavailable"
      ? t("settings.jevKeyStatusUnavailable")
      : keyStatus === "loading"
        ? t("settings.jevKeyStatusChecking")
        : t("settings.jevKeyMissing");

  const save = async () => {
    if (checking || !keyDraft.trim() || !normalized) return;
    const controller = new AbortController();
    aborted.current = controller;
    setChecking(true);
    try {
      const outcome = await addJevService(
        appJevConfigDeps(),
        keyDraft,
        normalized,
        controller.signal,
      );
      if (!outcome.ok) {
        if (outcome.reason === "cancelled") return;
        showToast(
          outcome.reason === "missing-key"
            ? t("settings.jevKeyRequired")
            : outcome.message || t("settings.jevKeyCheckFailed"),
          { variant: "error" },
        );
        return;
      }
      updateKey("");
      showToast(t("settings.jevServiceAdded"), { variant: "success" });
      onConfigured();
    } catch (error) {
      if (controller.signal.aborted) return;
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      if (!controller.signal.aborted) setChecking(false);
    }
  };

  const serviceLabel = custom
    ? t("settings.presetCustomEndpoint")
    : t("settings.jevOfficialService");

  return (
    <>
      <div className="provider-setup-head">
        <h3 id="provider-setup-title" className="provider-setup-title">
          {t("settings.jevTitle")}
        </h3>
        <div className="provider-setup-head-actions">
          <Button variant="ghost" size="sm" disabled={checking} onClick={onClose}>
            {t("settings.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={checking || !keyDraft.trim() || !normalized}
            onClick={() => void save()}
          >
            {checking ? t("settings.jevCheckingKey") : t("settings.jevTestAndSave")}
          </Button>
        </div>
      </div>

      <div className="provider-setup-body">
        <div className="provider-setup-credentials">
          <div className="jev-setup">
            <div className="block space-y-1.5">
              <div className="text-sm text-text-secondary">{t("settings.service")}</div>
              <div className="provider-service-chip">
                <ServiceMonogram name={serviceLabel} />
                <span className="provider-service-chip-copy">
                  <span className="provider-service-chip-name">{serviceLabel}</span>
                  <span className="provider-service-chip-host" title={binding.baseUrl}>
                    {endpointLabel(binding.baseUrl)}
                  </span>
                </span>
                {onChangeService ? (
                  <button
                    type="button"
                    className="provider-service-chip-change"
                    disabled={checking}
                    onClick={onChangeService}
                  >
                    {t("settings.changeService")}
                  </button>
                ) : null}
              </div>
            </div>
            <p className="jev-setup-description">{t("settings.jevDescription")}</p>
            <p className="jev-setup-privacy">{t("settings.jevPrivacyNotice")}</p>

            {custom ? (
              <div className="provider-setup-field-row provider-setup-custom-identity-row">
                <Field label={t("settings.jevBaseUrl")}>
                  <Input
                    value={binding.baseUrl}
                    type="url"
                    inputMode="url"
                    autoComplete="url"
                    className="font-mono text-sm-plus"
                    placeholder="https://openrouter.ai/api/v1"
                    aria-invalid={!validBaseUrl}
                    aria-describedby={!validBaseUrl ? "jev-base-url-error" : undefined}
                    disabled={checking}
                    onChange={(event) => onBindingChange?.({
                      ...binding,
                      baseUrl: event.target.value,
                    })}
                  />
                  {!validBaseUrl ? (
                    <div
                      id="jev-base-url-error"
                      className="provider-setup-field-error"
                      role="alert"
                    >
                      {t("settings.baseUrlInvalid")}
                    </div>
                  ) : null}
                </Field>
                <Field label={t("settings.jevModelId")}>
                  <Input
                    value={binding.modelId}
                    className="font-mono text-sm-plus"
                    placeholder="~typesafe/jev-latest"
                    aria-invalid={!validModelId}
                    aria-describedby={!validModelId ? "jev-model-id-error" : undefined}
                    disabled={checking}
                    onChange={(event) => onBindingChange?.({
                      ...binding,
                      modelId: event.target.value,
                    })}
                  />
                  {!validModelId ? (
                    <div
                      id="jev-model-id-error"
                      className="provider-setup-field-error"
                      role="alert"
                    >
                      {t("settings.customModelRequired")}
                    </div>
                  ) : null}
                </Field>
              </div>
            ) : null}

            <div className="provider-setup-field-row provider-setup-custom-auth-row">
              <Field label={t("settings.jevApiKey")}>
                <PasswordInput
                  value={keyDraft}
                  autoFocus
                  placeholder={t("settings.jevApiKeyPlaceholder")}
                  aria-label={t("settings.jevApiKey")}
                  autoComplete="new-password"
                  showLabel={t("settings.configSync.showPassword")}
                  hideLabel={t("settings.configSync.hidePassword")}
                  disabled={checking}
                  onChange={(event) => updateKey(event.target.value)}
                />
              </Field>
              {custom ? (
                <Field label={t("settings.apiStyle")}>
                  <SettingsMenuSelect
                    fullWidth
                    label={t("settings.apiStyle")}
                    value={JEV_SYSTEM_ONE_API_STYLE}
                    onChange={(id) => onApiStyleChange?.(id as ProviderSetupApiStyle)}
                    options={CUSTOM_PROVIDER_SETUP_API_STYLES.map((style) => ({
                      id: style,
                      label: t(PROVIDER_SETUP_API_STYLE_LABEL_KEYS[style]),
                    }))}
                  />
                </Field>
              ) : null}
            </div>

            <p className="jev-setup-status" role="status">{statusText}</p>
            <p className="jev-setup-note">{t("settings.jevClassifierOnlyNote")}</p>
          </div>
        </div>
      </div>
    </>
  );
}

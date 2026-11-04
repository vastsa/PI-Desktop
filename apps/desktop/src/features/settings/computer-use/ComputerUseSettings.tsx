import { useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import {
  COMPUTER_USE_DEFAULTS,
  type AppSettings,
  type ComputerCaptureMode,
  type ComputerInputPolicy,
  type ComputerUseSettings as ComputerUseSettingsValue,
  type ProviderPublic,
  needsAccessibilityRequest,
} from "@pi-desktop/shared";
import { Badge, Button, SettingsToggle } from "../../../components/ui";
import { SettingsMenuSelect } from "../../../components/settings/SettingsMenuSelect";
import { SettingsCard, SettingsRow } from "../primitives";
import { api } from "../../../lib/api";
import { useComputerPermission } from "../../computer-use/use-computer-permission";

/**
 * Computer use settings (ADR 0342).
 *
 * The three things only the user can decide live here: whether the capability
 * exists at all, which model may drive it, and whether a run may take pixels
 * of the window. Nothing here hands anything over — a grant is always minted
 * later, per target, from the indicator.
 */
export function ComputerUseSettings({
  t,
  settings,
  saveSettings,
}: {
  t: TFunction;
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const value: ComputerUseSettingsValue = settings.computerUse ?? { enabled: false };
  const { capabilities, requesting, waiting, errorCode, requestPermission } = useComputerPermission();
  const [providers, setProviders] = useState<ProviderPublic[]>([]);

  useEffect(() => {
    if (!value.enabled) return;
    let cancelled = false;
    void api
      .listProviders()
      .then((result) => {
        if (!cancelled) setProviders(result.providers.filter((provider) => provider.enabled));
      })
      .catch(() => {
        if (!cancelled) setProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [value.enabled]);

  const modelOptions = useMemo(() => {
    const options = [{ id: "", label: t("computerUse.chooseModel") }];
    for (const provider of providers) {
      for (const model of provider.models ?? []) {
        options.push({ id: `${provider.id}\u0000${model.id}`, label: `${provider.name} · ${model.id}` });
      }
    }
    return options;
  }, [providers, t]);

  const selectedModel = value.model ? `${value.model.providerId}\u0000${value.model.modelId}` : "";
  const unsupported = capabilities?.backend === "unsupported";

  const patch = (next: Partial<ComputerUseSettingsValue>) =>
    void saveSettings({ computerUse: { ...value, ...next } });

  return (
    <SettingsCard title={t("computerUse.title")} description={t("computerUse.description")}>
      <SettingsRow title={t("computerUse.enable")} description={t("computerUse.enableDesc")}>
        <SettingsToggle
          label={t("computerUse.enable")}
          checked={value.enabled}
          onChange={() => patch({ enabled: !value.enabled })}
        />
      </SettingsRow>

      {/* Readable before enabling: a platform without a backend should say so
          rather than let the user turn on a feature that cannot act. */}
      <SettingsRow title={t("computerUse.platform")}>
        <div className="computer-use-platform-status">
          {capabilities ? (
            <>
              <Badge tone={unsupported ? "warning" : "neutral"}>
                {unsupported ? t("computerUse.platformUnsupported") : capabilities.backend}
              </Badge>
              {needsAccessibilityRequest(capabilities) ? (
                <Button
                  size="sm"
                  className="computer-use-permission-button"
                  title={t("computerUse.requestPermission")}
                  disabled={requesting}
                  aria-busy={requesting}
                  onClick={() => { void requestPermission(); }}
                >
                  {requesting ? t("computerUse.requestingPermission") : t(`computerUse.permission.${capabilities.accessibility}`)}
                </Button>
              ) : (
                <Badge tone={capabilities.accessibility === "granted" ? "neutral" : "warning"}>
                  {t(`computerUse.permission.${capabilities.accessibility}`)}
                </Badge>
              )}
            </>
          ) : (
            <span className="settings-hint">{t("computerUse.platformUnknown")}</span>
          )}
        </div>
      </SettingsRow>
      {(waiting || errorCode) && (
        <p className="computer-use-picker-error" role="status">
          {errorCode
            ? t("computerUse.permissionRequestFailed", { code: errorCode })
            : t("computerUse.permissionPending")}
        </p>
      )}

      {value.enabled && (
        <>
          <SettingsRow title={t("computerUse.model")} description={t("computerUse.modelDesc")}>
            <SettingsMenuSelect
              label={t("computerUse.model")}
              value={selectedModel}
              onChange={(next) => {
                if (!next) {
                  patch({ model: null });
                  return;
                }
                const [providerId, modelId] = next.split("\u0000");
                if (providerId && modelId) patch({ model: { providerId, modelId } });
              }}
              options={modelOptions}
            />
          </SettingsRow>
          {!value.model && <div className="settings-hint">{t("computerUse.modelMissing")}</div>}

          <SettingsRow title={t("computerUse.inputPolicy")} description={t("computerUse.inputPolicyDesc")}>
            <SettingsMenuSelect
              label={t("computerUse.inputPolicy")}
              value={value.defaultInputPolicy ?? COMPUTER_USE_DEFAULTS.inputPolicy}
              onChange={(next) => patch({ defaultInputPolicy: next as ComputerInputPolicy })}
              options={[
                { id: "confirm-each", label: t("computerUse.policyConfirmEach") },
                { id: "autonomous-in-scope", label: t("computerUse.policyAutonomous") },
              ]}
            />
          </SettingsRow>

          <SettingsRow title={t("computerUse.capture")} description={t("computerUse.captureDesc")}>
            <SettingsMenuSelect
              label={t("computerUse.capture")}
              value={value.defaultCapture ?? COMPUTER_USE_DEFAULTS.capture}
              onChange={(next) => patch({ defaultCapture: next as ComputerCaptureMode })}
              options={[
                { id: "a11y-only", label: t("computerUse.captureA11yOnly") },
                { id: "a11y-and-pixels", label: t("computerUse.captureWithPixels") },
              ]}
            />
          </SettingsRow>
        </>
      )}
    </SettingsCard>
  );
}

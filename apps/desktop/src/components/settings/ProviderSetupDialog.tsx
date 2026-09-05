/**
 * One form to add or edit an AI service.
 *
 * Name, base URL and key are entered together, and the model list comes from
 * the service's own endpoint (`useProviderModels`) rather than from a browsable
 * catalog. models.dev only enriches the rows the service returned, which is why
 * context/output limits need no manual entry on the common path. Choosing among
 * those rows is `ModelSelectionPanes`, shared with the vendor account editor.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  API_STYLES,
  OPENCODE_GO_API_STYLE,
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_NAME,
  ZHIPU_ENDPOINT_PRESETS,
  matchZhipuPreset,
  type CatalogApiStyle,
  type ModelBinding,
  type ProviderPublic,
  type ZhipuPresetId,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button, Field, Input, Select } from "../ui";
import { useProviderModels } from "./useProviderModels";
import { ModelSelectionPanes, useModelSelection } from "./ModelSelectionPanes";

const CUSTOM_SERVICE = "custom";

const API_STYLE_LABEL_KEYS: Record<CatalogApiStyle, string> = {
  chat_completions: "settings.apiStyleChatCompletions",
  responses: "settings.apiStyleResponses",
  anthropic_messages: "settings.apiStyleAnthropic",
  google_generative_ai: "settings.apiStyleGoogle",
  openai_codex_responses: "settings.apiStyleCodexResponses",
  pi_messages: "settings.apiStylePiMessages",
  opencode_go: "settings.apiStyleOpenCodeGo",
};

const ZHIPU_PRESET_LABEL_KEYS: Record<ZhipuPresetId, string> = {
  zhipuai: "settings.presetZhipuApi",
  "zhipuai-coding-plan": "settings.presetZhipuCodingPlan",
  zai: "settings.presetZaiApi",
  "zai-coding-plan": "settings.presetZaiCodingPlan",
};

function serviceIdFor(provider?: ProviderPublic | null): string {
  if (!provider || provider.apiStyle === OPENCODE_GO_API_STYLE) return CUSTOM_SERVICE;
  return matchZhipuPreset({
    vendorKey: provider.vendorKey,
    baseUrl: provider.baseUrl,
  })?.id ?? CUSTOM_SERVICE;
}

function initialName(provider?: ProviderPublic | null): string {
  if (provider?.apiStyle === OPENCODE_GO_API_STYLE) return OPENCODE_GO_NAME;
  return provider?.name ?? "";
}

function initialBaseUrl(provider?: ProviderPublic | null): string {
  if (provider?.apiStyle === OPENCODE_GO_API_STYLE) return OPENCODE_GO_BASE_URL;
  return (
    matchZhipuPreset({
      vendorKey: provider?.vendorKey,
      baseUrl: provider?.baseUrl,
    })?.baseUrl ??
    provider?.baseUrl ??
    ""
  );
}

export type ProviderSetupDialogProps = {
  /** Existing row being edited; absent creates a new service. */
  provider?: ProviderPublic | null;
  onClose: () => void;
  /** Called after a successful create/update so the caller can refresh. */
  onSaved: (provider: ProviderPublic, models: ModelBinding[]) => void;
};

export function ProviderSetupDialog({
  provider,
  onClose,
  onSaved,
}: ProviderSetupDialogProps) {
  const { t } = useTranslation();
  const editing = !!provider;
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const [service, setService] = useState(() => serviceIdFor(provider));
  const [name, setName] = useState(() => initialName(provider));
  const [baseUrl, setBaseUrl] = useState(() => initialBaseUrl(provider));
  const [apiKey, setApiKey] = useState("");
  const [apiStyle, setApiStyle] = useState<CatalogApiStyle>(
    (provider?.apiStyle as CatalogApiStyle) ?? "chat_completions",
  );
  const [models, setModels] = useState<ModelBinding[]>(provider?.models ?? []);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState("");

  const zhipuPreset = ZHIPU_ENDPOINT_PRESETS.find((preset) => preset.id === service);
  const opencodeGo = apiStyle === OPENCODE_GO_API_STYLE;
  const lockBaseUrl = Boolean(zhipuPreset) || opencodeGo;
  const lockName = opencodeGo;
  const resolvedBaseUrl = zhipuPreset?.baseUrl ?? (opencodeGo ? OPENCODE_GO_BASE_URL : baseUrl);
  const discovery = useProviderModels(
    true,
    { baseUrl: resolvedBaseUrl, apiKey, apiStyle },
    provider,
  );
  const selection = useModelSelection(discovery, models, setModels);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  const focusApiKey = () => {
    queueMicrotask(() => apiKeyRef.current?.focus());
  };

  const onServiceChange = (next: string) => {
    const previous = zhipuPreset;
    setService(next);
    const preset = ZHIPU_ENDPOINT_PRESETS.find((item) => item.id === next);
    if (!preset) return;
    const currentName = name.trim();
    if (
      !currentName ||
      currentName === previous?.name ||
      currentName === OPENCODE_GO_NAME
    ) {
      setName(preset.name);
    }
    setBaseUrl(preset.baseUrl);
    if (apiStyle === OPENCODE_GO_API_STYLE) setApiStyle("chat_completions");
    focusApiKey();
  };

  const onApiStyleChange = (next: CatalogApiStyle) => {
    setApiStyle(next);
    if (next !== OPENCODE_GO_API_STYLE) return;
    setService(CUSTOM_SERVICE);
    setName(OPENCODE_GO_NAME);
    setBaseUrl(OPENCODE_GO_BASE_URL);
    focusApiKey();
  };

  const testConnection = async () => {
    if (!provider) return;
    setTesting(true);
    setTestResult("");
    try {
      const result = (await api.testProvider(provider.id)) as {
        ok?: boolean;
        message?: string;
        status?: number;
      };
      setTestResult(
        result?.ok
          ? t("settings.testOk")
          : result?.message ||
              (result?.status
                ? t("settings.testFailedStatus", { status: result.status })
                : t("settings.testFailed")),
      );
    } catch (cause) {
      setTestResult(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    const providerName = (opencodeGo ? OPENCODE_GO_NAME : name).trim();
    const providerBaseUrl = resolvedBaseUrl.trim();
    if (!providerName || !providerBaseUrl || models.length === 0) return;
    // Only levels the model publishes are stored; the runtime would drop the
    // rest while this dialog kept counting them as enabled.
    const persisted = selection.bindingsToPersist;
    const persistedApiStyle = zhipuPreset ? "chat_completions" : apiStyle;
    setSaving(true);
    setError("");
    try {
      if (provider) {
        const result = await api.updateProvider({
          id: provider.id,
          name: providerName,
          vendorKey: zhipuPreset?.vendorKey ?? "custom",
          baseUrl: providerBaseUrl,
          defaultModelId: persisted[0]?.id,
          models: persisted,
          apiStyle: persistedApiStyle,
          // An empty key on edit means "keep the stored one", so the secret is
          // only sent when the user actually typed a new value.
          ...(apiKey ? { secretValue: apiKey } : {}),
        });
        onSaved(result.provider ?? provider, persisted);
      } else {
        const result = await api.createProvider({
          name: providerName,
          vendorKey: zhipuPreset?.vendorKey ?? "custom",
          type: "openai_compatible",
          protocol: "openai_compatible",
          baseUrl: providerBaseUrl,
          authKind: "api_key_and_base_url",
          defaultModelId: persisted[0]?.id,
          models: persisted,
          secretValue: apiKey || undefined,
          apiStyle: persistedApiStyle,
        });
        onSaved(result.provider, persisted);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const canSave =
    !saving &&
    !!(opencodeGo ? OPENCODE_GO_NAME : name).trim() &&
    !!resolvedBaseUrl.trim() &&
    models.length > 0;
  const endpointHint = zhipuPreset?.codingPlan
    ? t("settings.presetZhipuCodingPlanHint")
    : opencodeGo
      ? t("settings.apiStyleOpenCodeGoFixed")
      : undefined;

  return (
    <div
      className="overlay provider-setup-overlay"
      role="presentation"
      onClick={() => {
        if (saving) return;
        onClose();
      }}
    >
      <div
        className="dialog provider-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-setup-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="provider-setup-head">
          <h3 id="provider-setup-title" className="provider-setup-title">
            {editing ? t("settings.editProviderTitle") : t("settings.addProviderTitle")}
          </h3>
          {/*
            The dialog's actions live here instead of a footer bar, so Save sits
            where the close affordance used to be. Cancel keeps the leftmost slot
            of the group so a stray click near the corner discards rather than
            saves, and Escape still closes the dialog.
          */}
          <div className="provider-setup-head-actions">
            {provider ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={testing || saving}
                onClick={() => void testConnection()}
              >
                {testing ? t("settings.testing") : t("settings.testConnection")}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
              {t("settings.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!canSave}
              onClick={() => void save()}
            >
              {saving ? t("settings.saving") : t("settings.saveProvider")}
            </Button>
          </div>
        </div>

        <div className="provider-setup-body">
          {/* A save failure belongs next to the fields, not under the panes. */}
          {error ? <div className="provider-setup-error">{error}</div> : null}

          <div className="provider-setup-credentials">
            <div className="provider-setup-fields">
              <Field label={t("settings.service")}>
                <Select
                  value={service}
                  onChange={(event) => onServiceChange(event.target.value)}
                >
                  <option value={CUSTOM_SERVICE}>
                    {t("settings.presetCustomEndpoint")}
                  </option>
                  {ZHIPU_ENDPOINT_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {t(ZHIPU_PRESET_LABEL_KEYS[preset.id])}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label={t("settings.name")}>
                <Input
                  value={opencodeGo ? OPENCODE_GO_NAME : name}
                  autoFocus={!opencodeGo && !zhipuPreset}
                  readOnly={lockName}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>

              <Field label={t("settings.baseUrl")} hint={endpointHint}>
                <Input
                  value={resolvedBaseUrl}
                  className="font-mono text-sm-plus"
                  placeholder="https://api.example.com/v1"
                  readOnly={lockBaseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </Field>

              <Field
                label={t("settings.apiKey")}
                hint={editing ? t("settings.apiKeyKeepHint") : t("settings.apiKeyHint")}
              >
                <Input
                  ref={apiKeyRef}
                  type="password"
                  value={apiKey}
                  placeholder="sk-…"
                  className="font-mono text-sm-plus"
                  autoComplete="off"
                  autoFocus={opencodeGo || Boolean(zhipuPreset)}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </Field>

              {/*
                Derived from the endpoint, but a plain fourth field: a whole
                disclosure for one select was more chrome than the setting.
              */}
              <Field label={t("settings.apiStyle")} hint={t("settings.apiStyleDerived")}>
                <Select
                  value={apiStyle}
                  onChange={(event) =>
                    onApiStyleChange(event.target.value as CatalogApiStyle)
                  }
                >
                  {API_STYLES.map((style) => (
                    <option key={style} value={style}>
                      {t(API_STYLE_LABEL_KEYS[style])}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {testResult ? (
              <div className="provider-credential-test">
                <span className="provider-credential-test-result">{testResult}</span>
              </div>
            ) : null}
          </div>

          <ModelSelectionPanes
            discovery={discovery}
            selection={selection}
            listTitle={t("settings.serviceModels")}
            busy={saving}
          />
        </div>
      </div>
    </div>
  );
}

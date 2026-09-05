/**
 * One form to add or edit an AI service.
 *
 * The common path is pick a named service and paste a key. Custom endpoint
 * still asks for a name and base URL. API format stays in Advanced, and
 * models come from the service's own endpoint (`useProviderModels`).
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
  if (!provider) return "";
  if (provider.apiStyle === OPENCODE_GO_API_STYLE) return OPENCODE_GO_API_STYLE;
  return (
    matchZhipuPreset({
      vendorKey: provider.vendorKey,
      baseUrl: provider.baseUrl,
    })?.id ?? CUSTOM_SERVICE
  );
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

function endpointHost(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
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
  const [advanced, setAdvanced] = useState(false);
  const [models, setModels] = useState<ModelBinding[]>(provider?.models ?? []);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState("");

  const zhipuPreset = ZHIPU_ENDPOINT_PRESETS.find((preset) => preset.id === service);
  const opencodeGo = service === OPENCODE_GO_API_STYLE;
  const named = Boolean(zhipuPreset) || opencodeGo;
  const custom = service === CUSTOM_SERVICE;
  const resolvedName = opencodeGo
    ? OPENCODE_GO_NAME
    : zhipuPreset
      ? name.trim() || zhipuPreset.name
      : name;
  const resolvedBaseUrl = zhipuPreset?.baseUrl ?? (opencodeGo ? OPENCODE_GO_BASE_URL : baseUrl);
  const resolvedApiStyle: CatalogApiStyle = zhipuPreset
    ? "chat_completions"
    : opencodeGo
      ? OPENCODE_GO_API_STYLE
      : apiStyle;
  const discovery = useProviderModels(
    true,
    { baseUrl: resolvedBaseUrl, apiKey, apiStyle: resolvedApiStyle },
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

  const applyNamedService = (nextName: string, nextUrl: string, nextStyle: CatalogApiStyle) => {
    const currentName = name.trim();
    const previous = zhipuPreset;
    if (
      !currentName ||
      currentName === previous?.name ||
      currentName === OPENCODE_GO_NAME
    ) {
      setName(nextName);
    }
    setBaseUrl(nextUrl);
    setApiStyle(nextStyle);
    focusApiKey();
  };

  const onServiceChange = (next: string) => {
    setService(next);
    const preset = ZHIPU_ENDPOINT_PRESETS.find((item) => item.id === next);
    if (preset) {
      applyNamedService(preset.name, preset.baseUrl, "chat_completions");
      return;
    }
    if (next === OPENCODE_GO_API_STYLE) {
      applyNamedService(OPENCODE_GO_NAME, OPENCODE_GO_BASE_URL, OPENCODE_GO_API_STYLE);
      return;
    }
    if (next === CUSTOM_SERVICE && apiStyle === OPENCODE_GO_API_STYLE) {
      setApiStyle("chat_completions");
    }
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
    const providerName = resolvedName.trim();
    const providerBaseUrl = resolvedBaseUrl.trim();
    if (!providerName || !providerBaseUrl || models.length === 0) return;
    const persisted = selection.bindingsToPersist;
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
          apiStyle: resolvedApiStyle,
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
          apiStyle: resolvedApiStyle,
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
    !!service &&
    !!resolvedName.trim() &&
    !!resolvedBaseUrl.trim() &&
    models.length > 0;

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
          {error ? <div className="provider-setup-error">{error}</div> : null}

          <div className="provider-setup-credentials">
            <div
              className={
                named
                  ? "provider-setup-fields is-named"
                  : custom
                    ? "provider-setup-fields is-custom"
                    : "provider-setup-fields is-empty"
              }
            >
              <div className="provider-setup-service">
                <Field label={t("settings.service")}>
                  <Select
                    value={service}
                    autoFocus={!named && !custom}
                    onChange={(event) => onServiceChange(event.target.value)}
                  >
                    <option value="" disabled>
                      {t("settings.chooseService")}
                    </option>
                    <option value={CUSTOM_SERVICE}>
                      {t("settings.presetCustomEndpoint")}
                    </option>
                    <optgroup label={t("settings.presetGroupZhipu")}>
                      {ZHIPU_ENDPOINT_PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {t(ZHIPU_PRESET_LABEL_KEYS[preset.id])}
                        </option>
                      ))}
                    </optgroup>
                    <option value={OPENCODE_GO_API_STYLE}>
                      {t("settings.apiStyleOpenCodeGo")}
                    </option>
                  </Select>
                </Field>
              </div>

              {named ? (
                <>
                  <Field
                    label={t("settings.apiKey")}
                    hint={editing ? t("settings.apiKeyKeepHint") : undefined}
                  >
                    <Input
                      ref={apiKeyRef}
                      type="password"
                      value={apiKey}
                      placeholder="sk-…"
                      className="font-mono text-sm-plus"
                      autoComplete="off"
                      autoFocus
                      onChange={(event) => setApiKey(event.target.value)}
                    />
                  </Field>
                  {resolvedBaseUrl ? (
                    <div className="provider-setup-host" title={resolvedBaseUrl}>
                      {endpointHost(resolvedBaseUrl)}
                    </div>
                  ) : null}
                </>
              ) : null}

              {custom ? (
                <>
                  <Field label={t("settings.name")}>
                    <Input
                      value={name}
                      autoFocus
                      onChange={(event) => setName(event.target.value)}
                    />
                  </Field>
                  <Field label={t("settings.baseUrl")}>
                    <Input
                      value={baseUrl}
                      className="font-mono text-sm-plus"
                      placeholder="https://api.example.com/v1"
                      onChange={(event) => setBaseUrl(event.target.value)}
                    />
                  </Field>
                  <div className="provider-setup-key">
                    <Field
                      label={t("settings.apiKey")}
                      hint={editing ? t("settings.apiKeyKeepHint") : undefined}
                    >
                      <Input
                        ref={apiKeyRef}
                        type="password"
                        value={apiKey}
                        placeholder="sk-…"
                        className="font-mono text-sm-plus"
                        autoComplete="off"
                        onChange={(event) => setApiKey(event.target.value)}
                      />
                    </Field>
                  </div>
                </>
              ) : null}
            </div>

            {service ? (
              <>
                <button
                  type="button"
                  className="provider-setup-advanced-toggle"
                  aria-expanded={advanced}
                  onClick={() => setAdvanced((open) => !open)}
                >
                  {t("settings.advanced")}
                </button>
                {advanced ? (
                  <div className="provider-setup-advanced">
                    {named ? (
                      <Field label={t("settings.name")}>
                        <Input
                          value={opencodeGo ? OPENCODE_GO_NAME : name}
                          readOnly={opencodeGo}
                          onChange={(event) => setName(event.target.value)}
                        />
                      </Field>
                    ) : null}
                    {custom ? (
                      <Field label={t("settings.apiStyle")}>
                        <Select
                          value={apiStyle}
                          onChange={(event) =>
                            setApiStyle(event.target.value as CatalogApiStyle)
                          }
                        >
                          {API_STYLES.filter((style) => style !== OPENCODE_GO_API_STYLE).map(
                            (style) => (
                              <option key={style} value={style}>
                                {t(API_STYLE_LABEL_KEYS[style])}
                              </option>
                            ),
                          )}
                        </Select>
                      </Field>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}

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

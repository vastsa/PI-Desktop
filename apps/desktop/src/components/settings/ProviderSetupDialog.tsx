/**
 * One form to add or edit an AI service.
 *
 * Named services: pick a vendor and paste a key. Custom: name, URL, key and
 * API format on the common path. Models come from the service endpoint.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  API_STYLES,
  NAMED_ENDPOINT_PRESETS,
  OPENCODE_GO_API_STYLE,
  matchNamedPreset,
  type CatalogApiStyle,
  type ModelBinding,
  type ProviderPublic,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button, Field, Input, Select } from "../ui";
import { useProviderModels } from "./useProviderModels";
import { ModelSelectionPanes, useModelSelection } from "./ModelSelectionPanes";
import { CUSTOM_SERVICE, ServicePicker } from "./ServicePicker";

const API_STYLE_LABEL_KEYS: Record<CatalogApiStyle, string> = {
  chat_completions: "settings.apiStyleChatCompletions",
  responses: "settings.apiStyleResponses",
  anthropic_messages: "settings.apiStyleAnthropic",
  google_generative_ai: "settings.apiStyleGoogle",
  openai_codex_responses: "settings.apiStyleCodexResponses",
  pi_messages: "settings.apiStylePiMessages",
  opencode_go: "settings.apiStyleOpenCodeGo",
};

function serviceIdFor(provider?: ProviderPublic | null): string {
  if (!provider) return "";
  return (
    matchNamedPreset({
      vendorKey: provider.vendorKey,
      baseUrl: provider.baseUrl,
      apiStyle: provider.apiStyle,
    })?.id ?? CUSTOM_SERVICE
  );
}

function initialName(provider?: ProviderPublic | null): string {
  return (
    matchNamedPreset({
      vendorKey: provider?.vendorKey,
      baseUrl: provider?.baseUrl,
      apiStyle: provider?.apiStyle,
    })?.name ??
    provider?.name ??
    ""
  );
}

function initialBaseUrl(provider?: ProviderPublic | null): string {
  return (
    matchNamedPreset({
      vendorKey: provider?.vendorKey,
      baseUrl: provider?.baseUrl,
      apiStyle: provider?.apiStyle,
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
  provider?: ProviderPublic | null;
  onClose: () => void;
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

  const namedPreset = NAMED_ENDPOINT_PRESETS.find((preset) => preset.id === service);
  const named = Boolean(namedPreset);
  const custom = service === CUSTOM_SERVICE;
  const resolvedName = namedPreset ? name.trim() || namedPreset.name : name;
  const resolvedBaseUrl = namedPreset?.baseUrl ?? baseUrl;
  const resolvedApiStyle: CatalogApiStyle = namedPreset?.apiStyle ?? apiStyle;
  // Named add-path waits for a key so picking a vendor does not 401-probe.
  // Editing reuses the stored secret. Custom still probes a valid URL alone.
  const discoveryActive =
    Boolean(service) && (custom || Boolean(apiKey.trim()) || Boolean(provider));
  const discovery = useProviderModels(
    discoveryActive,
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

  const nameRef = useRef<HTMLInputElement>(null);
  const focusAfterServiceChange = (next: string) => {
    window.setTimeout(() => {
      if (next === CUSTOM_SERVICE) nameRef.current?.focus();
      else if (next) apiKeyRef.current?.focus();
    }, 0);
  };

  const onServiceChange = (next: string) => {
    const previous = namedPreset;
    setService(next);
    const preset = NAMED_ENDPOINT_PRESETS.find((item) => item.id === next);
    if (!preset) {
      if (next === CUSTOM_SERVICE && apiStyle === OPENCODE_GO_API_STYLE) {
        setApiStyle("chat_completions");
      }
      focusAfterServiceChange(next);
      return;
    }
    const currentName = name.trim();
    if (!currentName || currentName === previous?.name) setName(preset.name);
    setBaseUrl(preset.baseUrl);
    setApiStyle(preset.apiStyle);
    focusAfterServiceChange(next);
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
          vendorKey: namedPreset?.vendorKey ?? "custom",
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
          vendorKey: namedPreset?.vendorKey ?? "custom",
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
                  <ServicePicker
                    value={service}
                    autoFocus={!named && !custom}
                    disabled={saving}
                    onChange={onServiceChange}
                  />
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
                      ref={nameRef}
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
                </>
              ) : null}
            </div>

            {named ? (
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
                    <Field label={t("settings.name")}>
                      <Input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </Field>
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

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
  normalizeApiStyle,
  type CatalogApiStyle,
  type ModelBinding,
  type ProviderPublic,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { pairsToRecord, recordToPairs } from "../extensions/KeyValueRows";
import { Button, Field, Input, Select } from "../ui";
import { ProviderHeadersEditor } from "./ProviderHeadersEditor";
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

type BaseUrlIssue = "invalid";

function endpointPathSuffixes(apiStyle: CatalogApiStyle): string[] {
  switch (apiStyle) {
    case "anthropic_messages":
    case "pi_messages":
      return ["/messages", "/models"];
    case "chat_completions":
      return ["/chat/completions", "/models"];
    case "responses":
    case "openai_codex_responses":
    case "opencode_go":
      return ["/responses", "/models"];
    case "google_generative_ai":
      return ["/models"];
    default:
      return ["/chat/completions", "/models"];
  }
}

function getBaseUrlIssue(value: string): BaseUrlIssue | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return "invalid";
    }
    return null;
  } catch {
    return "invalid";
  }
}

/** Keep pasted operation URLs usable by storing the service root instead. */
function normalizeBaseUrlInput(value: string, apiStyle: CatalogApiStyle): string {
  const trimmed = value.trim();
  if (!trimmed || getBaseUrlIssue(trimmed)) return trimmed;

  let normalized = trimmed.replace(/\/+$/, "");
  const suffixes = endpointPathSuffixes(apiStyle).sort(
    (left, right) => right.length - left.length,
  );
  for (const suffix of suffixes) {
    if (normalized.toLowerCase().endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length).replace(/\/+$/, "");
      break;
    }
  }
  return normalized || trimmed;
}

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
  const [apiStyle, setApiStyle] = useState<CatalogApiStyle>(() =>
    normalizeApiStyle(provider?.apiStyle),
  );
  const [headerPairs, setHeaderPairs] = useState(() => recordToPairs(provider?.headers));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [models, setModels] = useState<ModelBinding[]>(provider?.models ?? []);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState("");
  const [baseUrlTouched, setBaseUrlTouched] = useState(false);

  const namedPreset = NAMED_ENDPOINT_PRESETS.find((preset) => preset.id === service);
  const named = Boolean(namedPreset);
  const custom = service === CUSTOM_SERVICE;
  const resolvedName = namedPreset ? name.trim() || namedPreset.name : name;
  const resolvedBaseUrl = namedPreset?.baseUrl ?? baseUrl;
  const resolvedApiStyle: CatalogApiStyle = namedPreset?.apiStyle ?? apiStyle;
  const baseUrlIssue = getBaseUrlIssue(resolvedBaseUrl);
  const baseUrlError =
    baseUrlTouched && baseUrlIssue ? t("settings.baseUrlInvalid") : undefined;
  const requestBaseUrl = normalizeBaseUrlInput(resolvedBaseUrl, resolvedApiStyle);
  // Named add-path waits for a key so picking a vendor does not 401-probe.
  // Editing reuses the stored secret. Custom still probes a valid URL alone.
  const discoveryActive =
    Boolean(service) &&
    !baseUrlIssue &&
    (custom || Boolean(apiKey.trim()) || Boolean(provider));
  const headers = pairsToRecord(headerPairs);
  const discovery = useProviderModels(
    discoveryActive,
    {
      baseUrl: requestBaseUrl,
      apiKey,
      apiStyle: resolvedApiStyle,
      headers,
    },
    provider,
  );
  const selection = useModelSelection(discovery, models, setModels);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) return;
      if (advancedOpen) {
        setAdvancedOpen(false);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [advancedOpen, onClose, saving]);

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
    setBaseUrlTouched(false);
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

  const commitBaseUrl = () => {
    setBaseUrlTouched(true);
    const normalized = normalizeBaseUrlInput(baseUrl, resolvedApiStyle);
    if (normalized !== baseUrl) setBaseUrl(normalized);
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
    const providerBaseUrl = normalizeBaseUrlInput(resolvedBaseUrl, resolvedApiStyle);
    if (
      !providerName ||
      !providerBaseUrl ||
      getBaseUrlIssue(providerBaseUrl) ||
      models.length === 0
    ) {
      setBaseUrlTouched(true);
      return;
    }
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
          headers,
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
          headers,
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
    !baseUrlIssue &&
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
            {named || custom ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => setAdvancedOpen(true)}
              >
                {t("settings.advancedSettings")}
              </Button>
            ) : null}
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
              <div
                className={`provider-setup-field-row provider-setup-service-row ${
                  named ? "is-named" : "is-single"
                }`}
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
                ) : null}
              </div>

              {named && resolvedBaseUrl ? (
                <div className="provider-setup-host" title={resolvedBaseUrl}>
                  {endpointHost(resolvedBaseUrl)}
                </div>
              ) : null}

              {custom ? (
                <>
                  <div className="provider-setup-field-row provider-setup-custom-identity-row">
                    <Field label={t("settings.name")}>
                      <Input
                        ref={nameRef}
                        value={name}
                        autoFocus
                        onChange={(event) => setName(event.target.value)}
                      />
                    </Field>
                    <div className="provider-setup-base-url">
                      <Field label={t("settings.baseUrl")}>
                        <Input
                          value={baseUrl}
                          type="url"
                          inputMode="url"
                          autoComplete="url"
                          className="font-mono text-sm-plus"
                          placeholder="https://api.example.com/v1"
                          aria-invalid={Boolean(baseUrlError)}
                          aria-describedby={baseUrlError ? "provider-base-url-error" : undefined}
                          onChange={(event) => {
                            setBaseUrl(event.target.value);
                            setError("");
                          }}
                          onBlur={commitBaseUrl}
                        />
                        {baseUrlError ? (
                          <div
                            id="provider-base-url-error"
                            className="provider-setup-field-error"
                            role="alert"
                          >
                            {baseUrlError}
                          </div>
                        ) : null}
                      </Field>
                    </div>
                  </div>
                  <div className="provider-setup-field-row provider-setup-custom-auth-row">
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
                        disabled={saving}
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
                  </div>
                </>
              ) : null}
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
            onReload={discovery.reload}
          />
        </div>
      </div>

      {advancedOpen && (named || custom) ? (
        <div
          className="overlay provider-advanced-overlay"
          role="presentation"
          onClick={(event) => {
            event.stopPropagation();
            if (event.target === event.currentTarget) setAdvancedOpen(false);
          }}
        >
          <div
            className="dialog provider-advanced-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="provider-advanced-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="provider-advanced-head">
              <h4 id="provider-advanced-title" className="provider-advanced-title">
                {t("settings.advancedSettings")}
              </h4>
              <Button variant="ghost" size="sm" onClick={() => setAdvancedOpen(false)}>
                {t("settings.close")}
              </Button>
            </div>
            <div className="provider-advanced-body">
              <div className="provider-setup-advanced">
                {named ? (
                  <Field label={t("settings.name")}>
                    <Input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </Field>
                ) : null}
                <ProviderHeadersEditor pairs={headerPairs} onChange={setHeaderPairs} />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One dialog to add or edit an AI service, in two views (D625).
 *
 * A new service opens on the service chooser; picking a tile moves to the
 * form. Named services: paste a key and the recommended models are chosen as
 * soon as the service answers. Custom: name, URL, key and API format on the
 * common path. The service's own list is on the left and the models this
 * credential will run on the right, both visible from the first paint: a
 * recommended model is a starting point, never the only thing on screen.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  NAMED_ENDPOINT_PRESETS,
  OPENCODE_GO_API_STYLE,
  normalizeApiStyle,
  type CatalogApiStyle,
  type ModelBinding,
  type OAuthVendor,
  type ProviderPublic,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { pairsToRecord, recordToPairs } from "../extensions/KeyValueRows";
import { Button, Field, HelpIcon, Input, portalOverlay } from "../ui";
import { ProviderHeadersEditor } from "./ProviderHeadersEditor";
import { useProviderModels } from "./useProviderModels";
import { ModelSelectionPanes, useModelSelection } from "./ModelSelectionPanes";
import { ConnectionStatus, ProviderConnectionFields } from "./ProviderConnectionFields";
import { ServiceChooser } from "./ServiceChooser";
import { CUSTOM_SERVICE } from "./service-catalog";
import { useRecommendedModelSelection } from "./useRecommendedModelSelection";
import type { ProviderCopyDraft } from "./provider-copy";
import {
  API_STYLE_LABEL_KEYS,
  isAccountOnlyApiStyle,
  needsCustomApiStyleChoice,
  providerSetupPreset,
} from "./provider-api-style";

import {
  endpointsEqual,
  getBaseUrlIssue,
  normalizeBaseUrlInput,
  resolveEndpointDraft,
} from "./provider-endpoint-guidance";
import { ProviderEndpointGuidance } from "./ProviderEndpointGuidance";

function serviceIdFor(provider?: ProviderPublic | null): string {
  if (!provider) return "";
  return providerSetupPreset(provider)?.id ?? CUSTOM_SERVICE;
}

function initialName(provider?: ProviderPublic | null): string {
  return provider?.name ?? providerSetupPreset(provider)?.name ?? "";
}

function initialBaseUrl(provider?: ProviderPublic | null): string {
  return providerSetupPreset(provider)?.baseUrl ?? provider?.baseUrl ?? "";
}

export type ProviderSetupDialogProps = {
  provider?: ProviderPublic | null;
  initialDraft?: ProviderCopyDraft | null;
  onClose: () => void;
  imageModelIds?: string[];
  onSaved: (provider: ProviderPublic, models: ModelBinding[], imageModelIds?: string[]) => void | Promise<void>;
  /** Vendors a new row can sign in to instead of pasting a key. */
  vendors?: OAuthVendor[] | null;
  /** Leaves this dialog for the vendor's browser sign-in. */
  onPickSubscription?: (vendor: OAuthVendor) => void;
};

export function ProviderSetupDialog({
  provider,
  initialDraft,
  onClose,
  onSaved,
  imageModelIds,
  vendors,
  onPickSubscription,
}: ProviderSetupDialogProps) {
  const { t } = useTranslation();
  const [imageModelDraft, setImageModelDraft] = useState<string[] | undefined>();
  const editing = !!provider;
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const [service, setService] = useState(() => initialDraft
    ? initialDraft.apiStyle === OPENCODE_GO_API_STYLE
      ? NAMED_ENDPOINT_PRESETS.find((preset) => preset.apiStyle === OPENCODE_GO_API_STYLE)?.id ?? CUSTOM_SERVICE
      : CUSTOM_SERVICE
    : serviceIdFor(provider));
  const [name, setName] = useState(() => initialDraft?.name ?? initialName(provider));
  const [baseUrl, setBaseUrl] = useState(() => initialDraft?.baseUrl ?? initialBaseUrl(provider));
  const [apiKey, setApiKey] = useState("");
  const [apiStyle, setApiStyle] = useState<CatalogApiStyle>(() =>
    initialDraft?.apiStyle ?? normalizeApiStyle(provider?.apiStyle),
  );
  const [headerPairs, setHeaderPairs] = useState(() => recordToPairs(provider?.headers));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [models, setModels] = useState<ModelBinding[]>(initialDraft?.models ?? provider?.models ?? []);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState("");
  const [baseUrlTouched, setBaseUrlTouched] = useState(false);
  // A format the user picked by hand outranks every inference about this row.
  const [apiStyleTouched, setApiStyleTouched] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const chooserOpen = choosing || !service;

  const namedPreset = NAMED_ENDPOINT_PRESETS.find((preset) => preset.id === service);
  const named = Boolean(namedPreset);
  const custom = service === CUSTOM_SERVICE;
  const resolvedName = namedPreset ? name.trim() || namedPreset.name : name;
  const resolvedBaseUrl = namedPreset?.baseUrl ?? baseUrl;
  /*
    Endpoint resolution decides the format when the endpoint itself names one:
    a pasted operation, a published service address, or a known host. A format
    that already has an owner — the user's own pick, a named preset's, or the
    one stored on the row being edited — is never overridden. Inference is for
    a row that does not have an answer yet.
  */
  const endpointDraft = resolveEndpointDraft(
    resolvedBaseUrl,
    namedPreset?.apiStyle ?? apiStyle,
    named || editing || Boolean(initialDraft) || apiStyleTouched,
  );
  const resolvedApiStyle: CatalogApiStyle = endpointDraft.apiStyle;
  // Said out loud next to the format selector: an automatic decision the user
  // cannot see would be exactly the hidden rewrite this row must not have.
  const endpointFormatNote = endpointDraft.autoDetected
    ? t("settings.apiStyleAutoDetected", {
        format: t(API_STYLE_LABEL_KEYS[resolvedApiStyle]),
      })
    : undefined;
  const baseUrlIssue = getBaseUrlIssue(resolvedBaseUrl);
  const baseUrlError =
    baseUrlTouched && baseUrlIssue ? t("settings.baseUrlInvalid") : undefined;
  const requiresApiStyleChoice = custom && needsCustomApiStyleChoice(apiStyle, provider?.apiStyle);
  const accountOnlyApiStyle = isAccountOnlyApiStyle(apiStyle);
  const requestBaseUrl = normalizeBaseUrlInput(resolvedBaseUrl, resolvedApiStyle);
  // Named add-path waits for a key so picking a vendor does not 401-probe.
  // Editing reuses the stored secret. Custom still probes a valid URL alone.
  const discoveryActive =
    Boolean(service) &&
    !requiresApiStyleChoice &&
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
  const recommended = useRecommendedModelSelection({
    // A copy keeps the models it was copied with.
    enabled: !provider && !initialDraft?.models?.length,
    serviceKey: `${service}|${requestBaseUrl}|${resolvedApiStyle}`,
    discovery,
    setModels,
    namedService: named,
  });
  // Every edit made through the picker or the summary ends preselection.
  const selection = useModelSelection(discovery, models, recommended.setModels);

  /*
    The address that answered is what the field shows and the row saves. Only a
    field still holding the address the answer belongs to is updated: a URL
    typed since that probe belongs to the user, and a named preset carries its
    own address. Comparing against the address the answer was produced for —
    not against the field's rewritten form — is what keeps a fresh paste from
    being reverted to the previous result.
  */
  const discoveredBaseUrl = discovery.effectiveBaseUrl;
  const adoptedFrom = discovery.resolvedFrom;
  useEffect(() => {
    if (named || !discoveredBaseUrl || !adoptedFrom) return;
    setBaseUrl((current) => (endpointsEqual(current, adoptedFrom) ? discoveredBaseUrl : current));
  }, [named, discoveredBaseUrl, adoptedFrom]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) return;
      if (advancedOpen) {
        setAdvancedOpen(false);
        return;
      }
      // Changing an existing row's service backs out to its form.
      if (choosing && service) {
        setChoosing(false);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [advancedOpen, choosing, onClose, saving, service]);

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
    // A format picked for the previous service does not carry over: the new
    // service's own format, or the new address, decides again.
    setApiStyleTouched(false);
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

  const pickService = (next: string) => {
    setChoosing(false);
    if (next === service) {
      focusAfterServiceChange(next);
      return;
    }
    // A key belongs to the service it was pasted for.
    if (!provider) setApiKey("");
    onServiceChange(next);
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
      requiresApiStyleChoice ||
      !providerName ||
      !providerBaseUrl ||
      getBaseUrlIssue(providerBaseUrl) ||
      models.length === 0
    ) {
      setBaseUrlTouched(true);
      return;
    }
    const persisted = selection.bindingsToPersist;
    // Removing a configured model releases its image binding even when the
    // capability checkbox was untouched. Ordinary provider edits keep their
    // existing save path when the image selection did not change.
    const imageSelection = imageModelDraft ?? imageModelIds;
    const remainingImageModels = imageSelection?.filter((imageModelId) =>
      persisted.some((model) => model.id.toLowerCase() === imageModelId.toLowerCase()),
    );
    const imageModelIdsToSave = imageModelDraft !== undefined ||
      remainingImageModels?.length !== imageSelection?.length
      ? remainingImageModels
      : undefined;
    setSaving(true);
    setError("");
    try {
      if (provider) {
        const result = await api.updateProvider({
          id: provider.id,
          name: providerName,
          // A row whose stored wire format differs from the published preset is
          // no longer that preset, but its catalog identity is still its own.
          vendorKey: namedPreset?.vendorKey ?? provider?.vendorKey ?? "custom",
          baseUrl: providerBaseUrl,
          defaultModelId: persisted[0]?.id,
          models: persisted,
          apiStyle: resolvedApiStyle,
          headers,
          ...(apiKey ? { secretValue: apiKey } : {}),
        });
        await onSaved(result.provider ?? provider, persisted, imageModelIdsToSave);
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
        await onSaved(result.provider, persisted, imageModelIdsToSave);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const updateImageModelDraft = (id: string, selected: boolean) => {
    setImageModelDraft((current) => {
      const next = current ?? imageModelIds ?? [];
      if (selected) {
        return next.some((entry) => entry.toLowerCase() === id.toLowerCase()) ? next : [...next, id];
      }
      return next.filter((entry) => entry.toLowerCase() !== id.toLowerCase());
    });
  };

  const canSave =
    !saving &&
    !requiresApiStyleChoice &&
    !!service &&
    !!resolvedName.trim() &&
    !!resolvedBaseUrl.trim() &&
    !baseUrlIssue &&
    models.length > 0;

  const formView = (
    <>
      <div className="provider-setup-head">
        <h3 id="provider-setup-title" className="provider-setup-title">
          {initialDraft ? t("settings.copyProviderTitle") : editing ? t("settings.editProviderTitle") : t("settings.addProviderTitle")}
          {/* What a copy does and does not take is the title's own promise. */}
          {initialDraft ? <HelpIcon label={t("settings.copyProviderHint")} /> : null}
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

        <ProviderEndpointGuidance
          baseUrl={resolvedBaseUrl}
          apiStyle={resolvedApiStyle}
          disabled={saving}
          onApply={(suggestion) => {
            const preset = NAMED_ENDPOINT_PRESETS.find((item) =>
              item.baseUrl === suggestion.baseUrl && item.apiStyle === suggestion.apiStyle,
            );
            setService(preset?.id ?? CUSTOM_SERVICE);
            setBaseUrl(suggestion.baseUrl);
            setApiStyle(suggestion.apiStyle);
            setError("");
            setTestResult("");
          }}
        />

        <div className="provider-setup-credentials">
          <ProviderConnectionFields
            named={named}
            custom={custom}
            editing={editing}
            saving={saving}
            serviceLabel={namedPreset ? t(namedPreset.labelKey) : t("settings.presetCustomEndpoint")}
            serviceBaseUrl={namedPreset?.baseUrl ?? ""}
            onChangeService={() => setChoosing(true)}
            apiKeyRef={apiKeyRef}
            nameRef={nameRef}
            apiKey={apiKey}
            onApiKeyChange={setApiKey}
            name={name}
            onNameChange={setName}
            baseUrl={baseUrl}
            onBaseUrlChange={(value) => {
              setBaseUrl(value);
              setError("");
            }}
            commitBaseUrl={commitBaseUrl}
            baseUrlError={baseUrlError}
            apiStyle={apiStyle}
            onApiStyleChange={(value) => {
              // A hand-picked format is the user's answer and outranks the
              // endpoint's own suggestion from here on.
              setApiStyleTouched(true);
              setApiStyle(value);
            }}
            apiStyleNote={endpointFormatNote}
            accountOnlyApiStyle={accountOnlyApiStyle}
            requiresApiStyleChoice={requiresApiStyleChoice}
            status={<ConnectionStatus active={discoveryActive} discovery={discovery} named={named} />}
          />

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
          apiStyle={resolvedApiStyle}
          imageModelIds={imageModelDraft ?? imageModelIds}
          onImageModelChange={updateImageModelDraft}
          lookupContext={{
            baseUrl: requestBaseUrl,
            vendorKey: namedPreset?.vendorKey ?? provider?.vendorKey ?? "custom",
            providerId: provider?.id,
          }}
          autoPicked={recommended.autoPicked}
        />
      </div>
    </>
  );

  const chooserView = (
    <>
      <div className="provider-setup-head">
        <h3 id="provider-setup-title" className="provider-setup-title">
          {editing ? t("settings.changeServiceTitle") : t("settings.addProviderTitle")}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={service ? () => setChoosing(false) : onClose}
        >
          {t("settings.cancel")}
        </Button>
      </div>
      <ServiceChooser
        vendors={editing ? null : vendors}
        current={service}
        onPickService={pickService}
        onPickSubscription={editing ? undefined : onPickSubscription}
      />
    </>
  );

  return portalOverlay(
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
        {chooserOpen ? chooserView : formView}
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

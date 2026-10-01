import { useEffect, useMemo, useState } from "react";
import { useSyncExternalStore } from "react";
import type { TFunction } from "i18next";
import type { AppSettings, LiveBinding, LiveVoiceSettings, ProviderPublic } from "@pi-desktop/shared";
import { OAUTH_AUTH_KIND } from "@pi-desktop/shared";
import { Badge, Button, Input, SettingsToggle } from "../../../components/ui";
import { SettingsMenuSelect } from "../../../components/settings/SettingsMenuSelect";
import { SettingsCard, SettingsRow } from "../primitives";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { getLiveCallController } from "../../voice/live/live-call-controller";

type Adapter = LiveBinding["adapterId"];

export function LiveVoiceSettings({
  t,
  settings,
  saveSettings,
}: {
  t: TFunction;
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const live: LiveVoiceSettings = settings.liveVoice ?? { enabled: false, bindings: [] };
  const controller = getLiveCallController();
  const liveSnapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersLoadFailed, setProvidersLoadFailed] = useState(false);
  const [providersRequest, setProvidersRequest] = useState(0);
  const setSettingsTab = useAppStore((state) => state.setSettingsTab);
  const showToast = useAppStore((state) => state.showToast);
  const [saving, setSaving] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, { modelId?: string; voice?: string }>>({});
  const bindingByAdapter = useMemo(() => {
    const result = new Map<Adapter, LiveBinding>();
    for (const binding of live.bindings) if (!result.has(binding.adapterId)) result.set(binding.adapterId, binding);
    return result;
  }, [live.bindings]);

  useEffect(() => {
    let cancelled = false;
    setProvidersLoading(true);
    setProvidersLoadFailed(false);
    void api.listProviders().then((result) => {
      if (!cancelled) setProviders(result.providers);
    }).catch(() => {
      if (!cancelled) setProvidersLoadFailed(true);
    }).finally(() => {
      if (!cancelled) setProvidersLoading(false);
    });
    return () => { cancelled = true; };
  }, [providersRequest]);

  const providerChoices = (adapter: Adapter) => providers.filter((provider) => {
    if (adapter === "codex-live") return provider.vendorKey === "openai-codex" && provider.authKind === OAUTH_AUTH_KIND;
    if (provider.authKind === OAUTH_AUTH_KIND) return false;
    if (adapter === "gemini-live") return provider.vendorKey === "google" && provider.apiStyle === "google_generative_ai";
    return Boolean(provider.baseUrl);
  });

  const save = async (next: LiveVoiceSettings) => {
    setSaving(true);
    try {
      await saveSettings({ liveVoice: next });
      await controller.refreshStatus();
    } catch {
      showToast(t("liveVoice.saveFailed"), { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const updateBinding = (adapter: Adapter, patch: Record<string, string>): Promise<void> => {
    const current = bindingByAdapter.get(adapter);
    const providerId = patch.providerId ?? current?.providerId;
    if (!providerId) return Promise.resolve();
    const id = current?.id ?? `live-${adapter}-${crypto.randomUUID()}`;
    const currentModel = current && "modelId" in current ? current.modelId : undefined;
    const nextBinding: LiveBinding = adapter === "codex-live"
      ? { id, adapterId: adapter, providerId, voice: patch.voice ?? (current?.voice || "cove") }
      : adapter === "gemini-live"
        ? { id, adapterId: adapter, providerId, modelId: patch.modelId ?? (currentModel || "gemini-3.8-live"), voice: patch.voice ?? (current?.voice || "Kore") }
        : {
            id,
            adapterId: adapter,
            providerId,
            modelId: patch.modelId ?? (currentModel || "gpt-realtime-2.1"),
            voice: patch.voice ?? (current?.voice || "marin"),
            wireProfile: patch.wireProfile === "realtime-compat-v1" ? "realtime-compat-v1" : current?.adapterId === "openai-realtime" ? current.wireProfile : "realtime-ga",
          };
    const bindings = current
      ? live.bindings.map((binding) => binding.id === current.id ? nextBinding : binding)
      : [...live.bindings, nextBinding];
    return save({ ...live, bindings, selectedBindingId: patch.providerId ? id : live.selectedBindingId ?? id });
  };

  const removeBinding = (adapter: Adapter) => {
    const current = bindingByAdapter.get(adapter);
    if (!current) return;
    const bindings = live.bindings.filter((binding) => binding.id !== current.id);
    const selectedBindingId = live.selectedBindingId === current.id ? bindings[0]?.id : live.selectedBindingId;
    void save({ enabled: live.enabled, bindings, ...(selectedBindingId ? { selectedBindingId } : {}) });
  };

  const selected = liveSnapshot.call;
  const adapterLocked = (adapter: Adapter) => Boolean(selected && selected.bindingId === bindingByAdapter.get(adapter)?.id && !["ended", "failed"].includes(selected.phase));
  const providerLabel = (provider: ProviderPublic) => `${provider.name}${provider.enabled ? "" : ` · ${t("liveVoice.providerDisabled")}`}${provider.hasSecret ? "" : ` · ${t("liveVoice.credentialsMissing")}`}`;

  const renderAdapter = (adapter: Adapter) => {
    const current = bindingByAdapter.get(adapter);
    const choices = providerChoices(adapter);
    const readiness = current && liveSnapshot.status?.bindings.find((item) => item.bindingId === current.id);
    const locked = adapterLocked(adapter);
    const title = t(`liveVoice.adapters.${adapter}.title`);
    return (
      <SettingsCard key={adapter} title={title} description={t(`liveVoice.adapters.${adapter}.description`)}>
        {current && readiness ? (
          <SettingsRow title={t("liveVoice.bindingStatus")}>
            <Badge tone={readiness.selectable ? "success" : "warning"}>
              {readiness.selectable ? t("liveVoice.ready") : t(`liveVoice.readiness.${readiness.reason ?? "missing-provider"}`)}
            </Badge>
          </SettingsRow>
        ) : null}
        <SettingsRow title={t("liveVoice.provider")}>
          <SettingsMenuSelect
            value={current?.providerId ?? ""}
            label={t("liveVoice.provider")}
            disabled={saving || locked || providersLoading || providersLoadFailed}
            options={[
              { id: "", label: t("liveVoice.chooseProvider") },
              ...choices.map((provider) => ({ id: provider.id, label: providerLabel(provider) })),
              ...(current && !choices.some((item) => item.id === current.providerId)
                ? [{ id: current.providerId, label: t("liveVoice.providerUnavailable") }]
                : []),
            ]}
            onChange={(providerId) => providerId ? void updateBinding(adapter, { providerId }) : removeBinding(adapter)}
          />
        </SettingsRow>
        {!providersLoading && !providersLoadFailed && choices.length === 0 ? (
          <div className="live-voice-hint">{t("liveVoice.noCompatibleProviders")}</div>
        ) : null}
        {current ? (
          <SettingsRow title={t("liveVoice.useForNextCall")}>
            <SettingsToggle
              checked={live.selectedBindingId === current.id}
              label={t("liveVoice.useForNextCall")}
              disabled={saving || locked}
              onChange={() => void save({ ...live, selectedBindingId: current.id })}
            />
          </SettingsRow>
        ) : null}
        {current && adapter !== "codex-live" ? (
          <SettingsRow title={t("liveVoice.model")}>
            <Input
              aria-label={t("liveVoice.model")}
              value={drafts[current.id]?.modelId ?? ("modelId" in current ? current.modelId : "")}
              disabled={saving || locked}
              maxLength={160}
              onChange={(event) => {
                const modelId = event.currentTarget.value;
                setDrafts((all) => ({ ...all, [current.id]: { ...all[current.id], modelId } }));
              }}
              onBlur={(event) => {
                const modelId = event.currentTarget.value.trim();
                if (modelId) void updateBinding(adapter, { modelId }).finally(() => setDrafts((all) => { const next = { ...all }; delete next[current.id]; return next; }));
                else setDrafts((all) => { const next = { ...all }; delete next[current.id]; return next; });
              }}
            />
          </SettingsRow>
        ) : null}
        {current ? (
          <SettingsRow title={t("liveVoice.voice")}>
            <Input
              aria-label={t("liveVoice.voice")}
              value={drafts[current.id]?.voice ?? current.voice}
              disabled={saving || locked}
              maxLength={64}
              onChange={(event) => {
                const voice = event.currentTarget.value;
                setDrafts((all) => ({ ...all, [current.id]: { ...all[current.id], voice } }));
              }}
              onBlur={(event) => {
                const voice = event.currentTarget.value.trim();
                if (voice) void updateBinding(adapter, { voice }).finally(() => setDrafts((all) => { const next = { ...all }; delete next[current.id]; return next; }));
                else setDrafts((all) => { const next = { ...all }; delete next[current.id]; return next; });
              }}
            />
          </SettingsRow>
        ) : null}
        {current && adapter === "openai-realtime" ? (
          <SettingsRow title={t("liveVoice.profile")}>
            <SettingsMenuSelect
              value={current.adapterId === "openai-realtime" ? current.wireProfile : "realtime-ga"}
              label={t("liveVoice.profile")}
              disabled={saving || locked}
              options={[
                { id: "realtime-ga", label: t("liveVoice.profiles.realtime-ga") },
                { id: "realtime-compat-v1", label: t("liveVoice.profiles.realtime-compat-v1") },
              ]}
              onChange={(wireProfile) => updateBinding(adapter, { wireProfile })}
            />
          </SettingsRow>
        ) : null}
        {locked ? <SettingsRow title={t("liveVoice.bindingLocked")}>{t("liveVoice.bindingLockedDetail")}</SettingsRow> : null}
      </SettingsCard>
    );
  };

  return (
    <div className="settings-stack voice-settings live-voice-settings">
      <SettingsCard
        title={t("liveVoice.title")}
        description={t("liveVoice.description")}
        action={
          /* Model configuration owns provider accounts and login, so the
             card's link to it sits on the heading line rather than among the
             rows above the enable switch. */
          <Button
            variant="ghost"
            className="settings-text-action"
            onClick={() => setSettingsTab("agent")}
          >
            {t("settings.configuration")}
          </Button>
        }
      >
        <SettingsRow title={t("liveVoice.enable")} description={t("liveVoice.enableDetail")}>
          <SettingsToggle
            checked={live.enabled}
            label={t("liveVoice.enable")}
            busy={saving}
            onChange={() => void save({ ...live, enabled: !live.enabled })}
          />
        </SettingsRow>
        {providersLoading ? <div className="live-voice-hint" role="status">{t("common.loading")}</div> : null}
        {providersLoadFailed ? (
          <div className="live-voice-error" role="alert">
            {t("liveVoice.providersLoadFailed")}
            <Button size="sm" variant="secondary" onClick={() => setProvidersRequest((value) => value + 1)}>
              {t("errors.action.retry")}
            </Button>
          </div>
        ) : null}
      </SettingsCard>
      {renderAdapter("codex-live")}
      {renderAdapter("gemini-live")}
      {renderAdapter("openai-realtime")}
    </div>
  );
}

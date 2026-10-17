import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ConfigSyncCategorySelection,
  ConfigSyncHistoryEntry,
  ConfigSyncPendingApproval,
  ConfigSyncProgress,
  ConfigSyncState,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Badge, Button, PasswordInput, SettingsToggle } from "../ui";
import { IconCloudDown, IconRefresh, IconShield } from "../icons";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { configSyncProgressView } from "../../features/settings/config-sync-progress";
import { useAppStore } from "../../stores/app-store";
import {
  cacheConfigSyncHistory,
  cacheConfigSyncState,
  clearConfigSyncDraft,
  getCachedConfigSyncHistory,
  getCachedConfigSyncState,
  hasFreshConfigSyncHistory,
  readConfigSyncDraft,
  writeConfigSyncDraft,
} from "../../features/settings/config-sync-preferences";
import { ConfigSyncError } from "./ConfigSyncError";
import { ConfigSyncConnectionFields } from "./ConfigSyncConnectionFields";
import { ConfigSyncScopeFields } from "./ConfigSyncScopeFields";
import { ConfigSyncVaultSettings } from "./ConfigSyncVaultSettings";
import { SettingsDisclosure } from "./SettingsDisclosure";
import {
  type ConfigSyncForm,
  clearConfigSyncFormSecrets,
  configSyncConfigureInput,
  configSyncTestInput,
  draftFromForm,
  draftFromState,
  initialConfigSyncForm,
  selectionFromDraft,
} from "../../features/settings/config-sync-form";

function formatStamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function statusTone(
  status: ConfigSyncState["status"],
): "neutral" | "success" | "error" | "warning" {
  if (status === "upToDate") return "success";
  if (status === "offline" || status === "error" || status === "unsupportedServer") {
    return "error";
  }
  if (status === "conflict" || status === "awaitingActivation" || status === "locked") {
    return "warning";
  }
  return "neutral";
}

export function ConfigSyncPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [initialDraft] = useState(() => readConfigSyncDraft());
  const [state, setState] = useState<ConfigSyncState | null>(() =>
    getCachedConfigSyncState(),
  );
  // A cached state paints immediately when the user returns to the page. A
  // first visit still refreshes in the background, but never blocks the draft
  // form from being useful.
  const [loading, setLoading] = useState(() => getCachedConfigSyncState() === null);
  const [busy, setBusy] = useState<
    | "test"
    | "configure"
    | "sync"
    | "unlock"
    | "map"
    | "history"
    | "restore"
    | "password"
    | "disconnect"
    | null
  >(null);
  /** The last progress the host reported for a manual sync, if one is running. */
  const [progress, setProgress] = useState<ConfigSyncProgress | null>(null);
  const [history, setHistory] = useState<ConfigSyncHistoryEntry[]>(() =>
    getCachedConfigSyncHistory(),
  );
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<ConfigSyncForm>(() =>
    initialConfigSyncForm(initialDraft),
  );
  const [selection, setSelection] = useState<ConfigSyncCategorySelection>(() =>
    selectionFromDraft(initialDraft.categories),
  );
  const mountedRef = useRef(true);
  const formDirtyRef = useRef(initialDraft.saved === false);
  const stateRequestRef = useRef(0);
  const historyRequestRef = useRef(0);

  const applyState = useCallback((next: ConfigSyncState) => {
    // A host event or an explicit action is newer than any page-open refresh
    // still in flight. Invalidating that request prevents stale state from
    // replacing the result the user just triggered.
    stateRequestRef.current += 1;
    if (cacheConfigSyncState(next)) {
      historyRequestRef.current += 1;
      setHistory([]);
    }
    setState(next);
    setLoading(false);
  }, []);

  const hydrateSavedFields = useCallback((next: ConfigSyncState) => {
    if (formDirtyRef.current || !next.configured) return;
    const draft = draftFromState(next);
    // A clean form contains no transient credentials. Do not restore them from
    // a stale closure when Host broadcasts a background sync status update.
    setForm((current) => ({ ...current, ...initialConfigSyncForm(draft) }));
    setSelection(selectionFromDraft(draft.categories));
    writeConfigSyncDraft({ ...draft, saved: true });
  }, []);

  const refreshHistory = useCallback(async (showError: boolean) => {
    const requestId = ++historyRequestRef.current;
    try {
      const next = await api.configSyncListHistory();
      if (!mountedRef.current || requestId !== historyRequestRef.current) return;
      cacheConfigSyncHistory(next);
      setHistory(next);
    } catch (cause) {
      if (!showError || !mountedRef.current || requestId !== historyRequestRef.current) {
        return;
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const clearHistory = useCallback(() => {
    historyRequestRef.current += 1;
    cacheConfigSyncHistory([]);
    setHistory([]);
  }, []);

  const refresh = useCallback(async () => {
    const requestId = ++stateRequestRef.current;
    try {
      const next = await api.configSyncGetState();
      if (!mountedRef.current || requestId !== stateRequestRef.current) return;
      applyState(next);
      hydrateSavedFields(next);
      if (next.configured && !next.locked) {
        // History is supplementary. It should not hold the whole settings
        // surface behind a remote request, and a short-lived cache avoids a
        // second network round-trip when the user revisits the page.
        if (!hasFreshConfigSyncHistory()) void refreshHistory(false);
      } else {
        clearHistory();
      }
    } catch (cause) {
      if (!mountedRef.current || requestId !== stateRequestRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mountedRef.current && requestId === stateRequestRef.current) {
        setLoading(false);
      }
    }
  }, [applyState, clearHistory, hydrateSavedFields, refreshHistory]);

  const loadHistory = useCallback(async () => {
    if (!state?.configured || state.locked) return;
    setBusy("history");
    try {
      await refreshHistory(true);
    } finally {
      setBusy(null);
    }
  }, [refreshHistory, state?.configured, state?.locked]);

  useEffect(() => {
    void refresh();
    return api.onConfigSyncChanged((next) => {
      applyState(next);
      hydrateSavedFields(next);
      if (next.configured && !next.locked && !hasFreshConfigSyncHistory()) {
        void refreshHistory(false);
      } else if (!next.configured || next.locked) {
        clearHistory();
      }
    });
  }, [applyState, clearHistory, hydrateSavedFields, refresh, refreshHistory]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      historyRequestRef.current += 1;
    };
  }, []);

  // The report is only shown while the page is running a sync itself, so an
  // automatic run stays silent; the subscription is dropped with the page.
  useEffect(() => api.onConfigSyncProgress((next) => setProgress(next)), []);

  const updateForm = <K extends keyof ConfigSyncForm,>(key: K, value: ConfigSyncForm[K]) => {
    formDirtyRef.current = true;
    setForm((current) => ({ ...current, [key]: value }));
  };

  const updateSelection = (key: keyof ConfigSyncCategorySelection, value: boolean) => {
    formDirtyRef.current = true;
    setSelection((current) => ({ ...current, [key]: value }));
  };

  useEffect(() => {
    if (!formDirtyRef.current) return;
    writeConfigSyncDraft(draftFromForm(form, selection));
  }, [form, selection]);

  const run = async (
    operation: "test" | "configure" | "sync" | "unlock" | "disconnect",
  ) => {
    setBusy(operation);
    setError(null);
    try {
      if (operation === "test") {
        await api.configSyncTest(configSyncTestInput(form, selection, t("settings.configSync.defaultDevice")));
        showToast(t("settings.configSync.testSuccess"), { variant: "success" });
      } else if (operation === "configure") {
        clearHistory();
        const configuredState = await api.configSyncConfigure(
          configSyncConfigureInput(form, selection, t("settings.configSync.defaultDevice")),
        );
        // Show the saved connection immediately while the first full sync is
        // still running. The previous flow kept the page in its unconfigured
        // shape until sync completed, which made a slow first setup look stuck.
        applyState(configuredState);
        formDirtyRef.current = false;
        hydrateSavedFields(configuredState);
        setForm(clearConfigSyncFormSecrets);
        applyState(await api.configSyncSyncNow());
        void refreshHistory(false);
        showToast(t("settings.configSync.configured"), { variant: "success" });
      } else if (operation === "sync") {
        applyState(await api.configSyncSyncNow());
        void refreshHistory(false);
      } else if (operation === "unlock") {
        applyState(await api.configSyncUnlock(form.backupPassword));
        setForm((current) => ({ ...current, backupPassword: "" }));
      } else {
        applyState(await api.configSyncDisconnect());
        clearConfigSyncDraft();
        clearHistory();
        formDirtyRef.current = false;
        setForm(initialConfigSyncForm());
        setSelection(selectionFromDraft());
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refresh();
    } finally {
      // The request's own answer ends the run: once it has settled, whatever
      // the last report said is already stale.
      setProgress(null);
      setBusy(null);
    }
  };

  const changePassword = async () => {
    setBusy("password");
    setError(null);
    try {
      applyState(
        await api.configSyncChangePassword({
          currentPassword: form.currentBackupPassword,
          newPassword: form.newBackupPassword,
        }),
      );
      setForm((current) => ({
        ...current,
        currentBackupPassword: "",
        newBackupPassword: "",
      }));
      showToast(t("settings.configSync.passwordChanged"), { variant: "success" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const restore = async (entry: ConfigSyncHistoryEntry) => {
    const propagate = state?.mode === "sync";
    if (!window.confirm(t(propagate ? "settings.configSync.restoreConfirm" : "settings.configSync.restoreBackupConfirm"))) return;
    setBusy("restore");
    setError(null);
    try {
      applyState(
        await api.configSyncRestore({
          revisionId: entry.revisionId,
          acknowledgePropagation: propagate,
        }),
      );
      await refreshHistory(true);
      showToast(t("settings.configSync.restoreStarted"), { variant: "success" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const approve = async (approvalId: string, digest: string, accepted: boolean) => {
    setBusy("sync");
    setError(null);
    try {
      const next = accepted
        ? await api.configSyncApprove({ approvalId, digest })
        : await api.configSyncReject({ approvalId, digest });
      applyState(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const mapProject = async (logicalId: string) => {
    setBusy("map");
    setError(null);
    try {
      const picked = await api.pickProjectFolders();
      const paths = picked.folders?.filter(Boolean) ?? [];
      if (!paths.length) return;
      applyState(
        await api.configSyncMapProject({
          logicalId,
          path: paths[0],
          paths: paths,
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const togglePause = async () => {
    setBusy("sync");
    setError(null);
    try {
      applyState(await api.configSyncPause(!state?.paused));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const statusLabel = useMemo(() => {
    switch (state?.status ?? "notConfigured") {
      case "locked":
        return t("settings.configSync.status.locked");
      case "upToDate":
        return t("settings.configSync.status.upToDate");
      case "localChangesPending":
        return t("settings.configSync.status.localChangesPending");
      case "syncing":
        return t("settings.configSync.status.syncing");
      case "offline":
        return t("settings.configSync.status.offline");
      case "unsupportedServer":
        return t("settings.configSync.status.unsupportedServer");
      case "conflict":
        return t("settings.configSync.status.conflict");
      case "awaitingActivation":
        return t("settings.configSync.status.awaitingActivation");
      case "paused":
        return t("settings.configSync.status.paused");
      case "error":
        return t("settings.configSync.status.error");
      case "notConfigured":
      default:
        return t("settings.configSync.status.notConfigured");
    }
  }, [state?.status, t]);

  const approvalReasonLabel = (reason: ConfigSyncPendingApproval["reason"]) => {
    switch (reason) {
      case "newDevice":
        return t("settings.configSync.approvalReason.newDevice");
      case "securityChange":
        return t("settings.configSync.approvalReason.securityChange");
      case "dependency":
        return t("settings.configSync.approvalReason.dependency");
      case "mapping":
        return t("settings.configSync.approvalReason.mapping");
      case "conflict":
        return t("settings.configSync.approvalReason.conflict");
    }
  };

  const configured = state?.configured === true;
  const locked = state?.locked === true;
  const stateReady = state !== null;
  const syncing = state?.status === "syncing";
  const controlsBusy = busy !== null || syncing;
  const categories = selection;
  const connectionReady = Boolean(form.endpoint.trim() && form.region.trim() && form.bucket.trim() && form.accessKeyId.trim());
  const vaultPasswordReady =
    form.backupPassword.length === 0
      ? configured && !locked
      : form.backupPassword.length >= 8;
  // Host progress continues independently of this view; a page reopened while
  // syncing listens for the remaining reports and keeps duplicate actions off.
  const syncProgress =
    (syncing || busy === "sync" || busy === "configure") && progress
      ? configSyncProgressView(progress)
      : null;

  return (
    <div
      className="settings-stack settings-config-sync"
      aria-busy={loading || undefined}
    >
      <p className="settings-config-sync-intro">{t("settings.configSync.connectionDescription")}</p>
      {loading && !state ? (
        <div className="settings-config-sync-refresh" role="status">
          <IconRefresh size={14} />
          {t("common.loading")}
        </div>
      ) : null}
      {error || state?.lastError ? (
        <ConfigSyncError message={error ?? state?.lastError ?? ""} />
      ) : null}
      {state?.configured && (
        <SettingsCard title={t("settings.configSync.statusTitle")}>
          <SettingsRow title={t("settings.configSync.statusLabel")}
            detail={<>
              <span>{state.bucket}</span>
              {state.lastSuccessAt ? <span>{" · "}{t("settings.configSync.lastSuccess", { date: formatStamp(state.lastSuccessAt) })}</span> : null}
            </>}>
            <div className="settings-config-sync-actions">
              <Badge tone={statusTone(state.status)}>{statusLabel}</Badge>
              {!locked ? (
                <Button variant="primary" onClick={() => void run("sync")}
                  disabled={controlsBusy || state.paused}>
                  <IconCloudDown size={14} />
                  {t(state.mode === "backup" ? "settings.configSync.backupNow" : "settings.configSync.syncNow")}
                </Button>
              ) : null}
            </div>
          </SettingsRow>
          {locked ? (
            <SettingsRow title={t("settings.configSync.unlockTitle")}
              description={t("settings.configSync.unlockDescription")}>
              <div className="settings-config-sync-password-actions">
                <PasswordInput value={form.backupPassword}
                  onChange={(event) => updateForm("backupPassword", event.target.value)}
                  aria-label={t("settings.configSync.backupPassword")} autoComplete="current-password"
                  showLabel={t("settings.configSync.showPassword")} hideLabel={t("settings.configSync.hidePassword")}
                  disabled={controlsBusy} />
                <Button variant="primary" onClick={() => void run("unlock")}
                  disabled={controlsBusy || !form.backupPassword}>
                  <IconShield size={14} />
                  {t("settings.configSync.unlock")}
                </Button>
              </div>
            </SettingsRow>
          ) : (
            <SettingsRow title={t("settings.configSync.pauseTitle")}
              description={t("settings.configSync.pauseDescription")}>
              <SettingsToggle checked={state.paused} label={t("settings.configSync.pauseTitle")}
                disabled={controlsBusy} onChange={() => void togglePause()} />
            </SettingsRow>
          )}
        </SettingsCard>
      )}

      {/* Progress is independent of setup, including the first configuration. */}
      {syncProgress ? (
        <div className="settings-config-sync-progress">
          <div className="settings-config-sync-progress-head">
            <span className="settings-config-sync-progress-title">
              {t("settings.configSync.progressTitle")}
            </span>
            <span className="settings-config-sync-progress-phase" role="status">
              {t(syncProgress.phaseKey)}
            </span>
          </div>
          {syncProgress.determinate ? (
            <div
              className="settings-config-sync-progress-bar"
              role="progressbar"
              aria-label={t("settings.configSync.progressTitle")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={syncProgress.percent}
              aria-valuetext={syncProgress.fraction ?? undefined}
            >
              <span
                className="settings-config-sync-progress-bar-fill"
                style={{ width: `${syncProgress.percent}%` }}
              />
            </div>
          ) : null}
          {syncProgress.determinate ? (
            <div className="settings-config-sync-progress-figures">
              {syncProgress.objects ? (
                <span>
                  {t(
                    "settings.configSync.progress.objects",
                    syncProgress.objects,
                  )}
                </span>
              ) : null}
              {syncProgress.bytes ? (
                <span>
                  {t("settings.configSync.progress.bytes", syncProgress.bytes)}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <SettingsCard>
        <SettingsDisclosure title={t("settings.configSync.connectionTitle")}
          open={!configured || initialDraft.saved === false}>
          <ConfigSyncConnectionFields form={form} configured={configured} locked={locked}
            disabled={controlsBusy} onChange={updateForm} />
          <ConfigSyncScopeFields selection={selection} disabled={controlsBusy} onChange={updateSelection} />
          <div className="settings-config-sync-actions settings-config-sync-form-actions">
            <Button variant="secondary" onClick={() => void run("test")}
              disabled={controlsBusy || loading || !stateReady || !connectionReady}>
              <IconRefresh size={14} />
              {t("settings.configSync.test")}
            </Button>
            <Button variant="primary" onClick={() => void run("configure")}
              disabled={controlsBusy || loading || !stateReady || !connectionReady || !vaultPasswordReady}>
              <IconCloudDown size={14} />
              {configured ? t("settings.configSync.save") : t("settings.configSync.enable")}
            </Button>
          </div>
        </SettingsDisclosure>
      </SettingsCard>

      {configured ? (
        <>

          {state?.pendingApprovals.length ? (
            <SettingsCard
              title={t("settings.configSync.approvalsTitle")}
              description={t("settings.configSync.approvalsDescription")}
            >
              <div className="settings-config-sync-approvals">
                {state.pendingApprovals.map((approval) => (
                  <div key={approval.id} className="settings-config-sync-approval">
                    <div>
                      <div className="settings-config-sync-approval-title">
                        {approval.label}
                      </div>
                      <div className="settings-config-sync-approval-meta">
                        {approvalReasonLabel(approval.reason)}
                      </div>
                    </div>
                    <div className="settings-config-sync-actions">
                      {approval.mappingKey ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void mapProject(approval.mappingKey!)}
                          disabled={controlsBusy}
                        >
                          {t("settings.configSync.mapFolder")}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void approve(approval.id, approval.digest, false)}
                        disabled={controlsBusy}
                      >
                        {t("settings.configSync.reject")}
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => void approve(approval.id, approval.digest, true)}
                        disabled={controlsBusy}
                      >
                        {t("settings.configSync.approve")}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </SettingsCard>
          ) : null}

          {state?.preview ? (
            <SettingsCard>
              <SettingsDisclosure title={t("settings.configSync.previewTitle")}>
              <div className="settings-config-sync-preview">
                <span>
                  {t("settings.configSync.previewSupported", {
                    count: state.preview.supported,
                  })}
                </span>
                <span>
                  {t("settings.configSync.previewExcluded", {
                    count: state.preview.excluded,
                  })}
                </span>
                <span>
                  {t("settings.configSync.previewSecrets", {
                    count: state.preview.secretBearing,
                  })}
                </span>
                <span>
                  {t("settings.configSync.previewMapping", {
                    count: state.preview.mappingRequired,
                  })}
                </span>
                <span>
                  {t("settings.configSync.previewPending", {
                    count: state.preview.pendingActivation,
                  })}
                </span>
                <span>
                  {t("settings.configSync.previewConflicts", {
                    count: state.preview.conflicts,
                  })}
                </span>
              </div>
              </SettingsDisclosure>
            </SettingsCard>
          ) : null}

          {state?.mappings.length ? (
            <SettingsCard>
              <SettingsDisclosure title={t("settings.configSync.mappingsTitle")}>
                <p className="settings-config-sync-note">{t("settings.configSync.mappingsDescription")}</p>
              <div className="settings-config-sync-mappings">
                {state.mappings.map((mapping) => (
                  <div key={mapping.logicalId} className="settings-config-sync-mapping">
                    <span className="settings-config-sync-mapping-id">
                      {mapping.logicalId}
                    </span>
                    <code>
                      {mapping.paths?.length
                        ? mapping.paths.join(" · ")
                        : mapping.path ?? t("settings.configSync.mappingUnavailable")}
                    </code>
                  </div>
                ))}
              </div>
              </SettingsDisclosure>
            </SettingsCard>
          ) : null}

          <SettingsCard>
            <SettingsDisclosure title={t("settings.configSync.historyTitle")}>
              <p className="settings-config-sync-note">{t("settings.configSync.historyDescription")}</p>
            <div className="settings-config-sync-history-actions">
              <Button
                variant="secondary"
                onClick={() => void loadHistory()}
                disabled={controlsBusy || locked}
              >
                <IconRefresh size={14} />
                {t("settings.configSync.refreshHistory")}
              </Button>
            </div>
            {history.length ? (
              <div className="settings-config-sync-history">
                {history.map((entry) => (
                  <div key={entry.revisionId} className="settings-config-sync-history-row">
                    <div>
                      <div className="settings-config-sync-approval-title">
                        {entry.current
                          ? t("settings.configSync.currentRevision")
                          : entry.revisionId}
                      </div>
                      <div className="settings-config-sync-approval-meta">
                        {formatStamp(entry.createdAt)} · {entry.entityCount}{" "}
                        {t("settings.configSync.historyItems")}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void restore(entry)}
                      disabled={controlsBusy || (entry.current && state.mode === "sync") || locked}
                    >
                      {t("settings.configSync.restore")}
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="settings-config-sync-history-empty">
                {locked
                  ? t("settings.configSync.historyLocked")
                  : t("settings.configSync.historyEmpty")}
              </div>
            )}
            </SettingsDisclosure>
          </SettingsCard>

          <ConfigSyncVaultSettings form={form} locked={locked} disabled={controlsBusy}
            onChange={updateForm} onChangePassword={() => void changePassword()}
            onDisconnect={() => void run("disconnect")} />
        </>
      ) : null}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ConfigSyncCategory,
  ConfigSyncCategorySelection,
  ConfigSyncHistoryEntry,
  ConfigSyncPendingApproval,
  ConfigSyncProgress,
  ConfigSyncRemoteMode,
  ConfigSyncState,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Badge, Button, Field, Input, PasswordInput, cx } from "../ui";
import { IconCloudDown, IconRefresh, IconShield, IconTrash } from "../icons";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { configSyncProgressView } from "../../features/settings/config-sync-progress";
import { ConfigSyncError } from "./ConfigSyncError";
import { SettingsMenuSelect } from "./SettingsMenuSelect";

function formatStamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

const CATEGORIES: Array<{
  id: Exclude<ConfigSyncCategory, "credentials" | "memory">;
  label: string;
}> = [
  { id: "application", label: "settings.configSync.categoryApplication" },
  { id: "providers", label: "settings.configSync.categoryProviders" },
  { id: "mcp", label: "settings.configSync.categoryMcp" },
  { id: "skills", label: "settings.configSync.categorySkills" },
  { id: "subagents", label: "settings.configSync.categorySubagents" },
  { id: "instructions", label: "settings.configSync.categoryInstructions" },
  { id: "projects", label: "settings.configSync.categoryProjects" },
  { id: "plugins", label: "settings.configSync.categoryPlugins" },
  { id: "automation", label: "settings.configSync.categoryAutomation" },
];

const DEFAULT_SELECTION: ConfigSyncCategorySelection = {
  application: true,
  providers: true,
  credentials: false,
  mcp: true,
  skills: true,
  subagents: true,
  instructions: true,
  projects: true,
  plugins: true,
  automation: true,
  memory: false,
};

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
  const [state, setState] = useState<ConfigSyncState | null>(null);
  const [loading, setLoading] = useState(true);
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
  const [history, setHistory] = useState<ConfigSyncHistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    endpoint: "",
    username: "",
    appPassword: "",
    directory: "pi-desktop",
    deviceLabel: "",
    backupPassword: "",
    currentBackupPassword: "",
    newBackupPassword: "",
  });
  const [selection, setSelection] =
    useState<ConfigSyncCategorySelection>(DEFAULT_SELECTION);
  const [remoteMode, setRemoteMode] = useState<ConfigSyncRemoteMode>("strict");

  const refresh = useCallback(async () => {
    try {
      const next = await api.configSyncGetState();
      setState(next);
      setRemoteMode(next.remoteMode ?? "strict");
      if (next.configured) {
        setForm((current) => ({
          ...current,
          endpoint: next.endpoint ?? current.endpoint,
          username: next.username ?? current.username,
          directory: next.directory ?? current.directory,
          deviceLabel: next.deviceLabel ?? current.deviceLabel,
        }));
        setSelection((current) => ({
          ...current,
          ...next.categories,
          credentials: next.includeSecrets,
          memory: next.includeMemory,
        }));
        if (!next.locked) {
          try {
            setHistory(await api.configSyncListHistory());
          } catch {
            setHistory([]);
          }
        } else {
          setHistory([]);
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    if (!state?.configured || state.locked) return;
    setBusy("history");
    try {
      setHistory(await api.configSyncListHistory());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, [state?.configured, state?.locked]);

  useEffect(() => {
    void refresh();
    return api.onConfigSyncChanged((next) => {
      setState(next);
      setRemoteMode(next.remoteMode ?? "strict");
    });
  }, [refresh]);

  // The report is only shown while the page is running a sync itself, so an
  // automatic run stays silent; the subscription is dropped with the page.
  useEffect(() => api.onConfigSyncProgress((next) => setProgress(next)), []);

  const updateForm = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const run = async (
    operation: "test" | "configure" | "sync" | "unlock" | "disconnect",
  ) => {
    if (
      operation === "configure" &&
      remoteMode === "appendOnly" &&
      !window.confirm(t("settings.configSync.appendOnlyConfirm"))
    ) {
      return;
    }
    setBusy(operation);
    setError(null);
    setNotice(null);
    try {
      if (operation === "test") {
        const result = await api.configSyncTest({
          endpoint: form.endpoint,
          username: form.username,
          appPassword: form.appPassword || undefined,
          directory: form.directory,
          deviceLabel: form.deviceLabel || t("settings.configSync.defaultDevice"),
          categories: selection,
          includeSecrets: selection.credentials,
          includeMemory: selection.memory,
          automaticSync: true,
          remoteMode,
        });
        setNotice(
          remoteMode === "appendOnly"
            ? result.appendOnly
              ? t("settings.configSync.testAppendOnlySuccess")
              : t("settings.configSync.testAppendOnlyUnsupported")
            : result.conditionalWrites
              ? t("settings.configSync.testSuccess")
              : t("settings.configSync.testUnsupported"),
        );
      } else if (operation === "configure") {
        await api.configSyncConfigure({
          endpoint: form.endpoint,
          username: form.username,
          appPassword: form.appPassword || undefined,
          directory: form.directory,
          deviceLabel: form.deviceLabel || t("settings.configSync.defaultDevice"),
          backupPassword: form.backupPassword,
          categories: selection,
          includeSecrets: selection.credentials,
          includeMemory: selection.memory,
          automaticSync: true,
          remoteMode,
        });
        setState(await api.configSyncSyncNow());
        setForm((current) => ({ ...current, appPassword: "", backupPassword: "" }));
        setNotice(t("settings.configSync.configured"));
      } else if (operation === "sync") {
        setState(await api.configSyncSyncNow());
      } else if (operation === "unlock") {
        setState(await api.configSyncUnlock(form.backupPassword));
        setForm((current) => ({ ...current, backupPassword: "" }));
      } else {
        setState(await api.configSyncDisconnect());
        setHistory([]);
        setRemoteMode("strict");
        setForm((current) => ({ ...current, appPassword: "", backupPassword: "" }));
        setSelection(DEFAULT_SELECTION);
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
    setNotice(null);
    try {
      setState(
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
      setNotice(t("settings.configSync.passwordChanged"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const restore = async (entry: ConfigSyncHistoryEntry) => {
    if (!window.confirm(t("settings.configSync.restoreConfirm"))) return;
    setBusy("restore");
    setError(null);
    try {
      setState(
        await api.configSyncRestore({
          revisionId: entry.revisionId,
          acknowledgePropagation: true,
        }),
      );
      setHistory(await api.configSyncListHistory());
      setNotice(t("settings.configSync.restoreStarted"));
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
      setState(next);
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
      setState(
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
      setState(await api.configSyncPause(!state?.paused));
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

  if (loading) {
    return (
      <div className="settings-recovery" role="status">
        {t("common.loading")}
      </div>
    );
  }

  const configured = state?.configured === true;
  const locked = state?.locked === true;
  const categories = selection;
  const vaultPasswordReady =
    form.backupPassword.length === 0
      ? configured && !locked
      : form.backupPassword.length >= 8;
  // The report only exists for a sync this page started: an automatic run stays
  // quiet, and no report outlives the request that produced it. Enabling a
  // vault runs the same full sync as "sync now", so both operations are watched.
  const syncProgress =
    (busy === "sync" || busy === "configure") && progress
      ? configSyncProgressView(progress)
      : null;

  return (
    <div className="settings-stack settings-config-sync">
      {error || state?.lastError ? (
        <ConfigSyncError message={error ?? state?.lastError ?? ""} />
      ) : null}
      <SettingsCard
        title={t("settings.configSync.connectionTitle")}
        description={t("settings.configSync.connectionDescription")}
      >
        <div className="settings-config-sync-form">
          <Field label={t("settings.configSync.endpoint")}>
            <Input
              value={form.endpoint}
              onChange={(event) => updateForm("endpoint", event.target.value)}
              placeholder={t("settings.configSync.endpointPlaceholder")}
              aria-label={t("settings.configSync.endpoint")}
              autoComplete="url"
              disabled={busy !== null}
            />
          </Field>
          <Field
            label={t("settings.configSync.remoteMode")}
            hint={t("settings.configSync.remoteModeHint")}
          >
            <SettingsMenuSelect
              fullWidth
              label={t("settings.configSync.remoteMode")}
              value={remoteMode}
              disabled={busy !== null}
              options={[
                {
                  id: "strict",
                  label: t("settings.configSync.remoteModeStrict"),
                },
                {
                  id: "appendOnly",
                  label: t("settings.configSync.remoteModeAppendOnly"),
                },
              ]}
              onChange={(value) => setRemoteMode(value as ConfigSyncRemoteMode)}
            />
          </Field>
          {remoteMode === "appendOnly" ? (
            <div className="settings-config-sync-warning" role="alert">
              {t("settings.configSync.appendOnlyWarning")}
            </div>
          ) : null}
          <Field label={t("settings.configSync.username")}>
            <Input
              value={form.username}
              onChange={(event) => updateForm("username", event.target.value)}
              aria-label={t("settings.configSync.username")}
              autoComplete="username"
              disabled={busy !== null}
            />
          </Field>
          <Field label={t("settings.configSync.appPassword")}>
            <PasswordInput
              value={form.appPassword}
              onChange={(event) => updateForm("appPassword", event.target.value)}
              aria-label={t("settings.configSync.appPassword")}
              autoComplete="current-password"
              showLabel={t("settings.configSync.showPassword")}
              hideLabel={t("settings.configSync.hidePassword")}
              disabled={busy !== null}
            />
          </Field>
          <Field label={t("settings.configSync.directory")}>
            <Input
              value={form.directory}
              onChange={(event) => updateForm("directory", event.target.value)}
              aria-label={t("settings.configSync.directory")}
              autoComplete="off"
              disabled={busy !== null}
            />
          </Field>
          <Field label={t("settings.configSync.deviceLabel")}>
            <Input
              value={form.deviceLabel}
              onChange={(event) => updateForm("deviceLabel", event.target.value)}
              placeholder={t("settings.configSync.defaultDevice")}
              aria-label={t("settings.configSync.deviceLabel")}
              autoComplete="off"
              disabled={busy !== null}
            />
          </Field>
          <Field
            label={
              configured
                ? t("settings.configSync.backupPasswordUnlock")
                : t("settings.configSync.backupPassword")
            }
            hint={t("settings.configSync.backupPasswordHint")}
          >
            <PasswordInput
              value={form.backupPassword}
              onChange={(event) => updateForm("backupPassword", event.target.value)}
              aria-label={t("settings.configSync.backupPassword")}
              autoComplete="new-password"
              showLabel={t("settings.configSync.showPassword")}
              hideLabel={t("settings.configSync.hidePassword")}
              disabled={busy !== null}
            />
          </Field>
        </div>
        <div className="settings-config-sync-actions">
          <Button
            variant="secondary"
            onClick={() => void run("test")}
            disabled={busy !== null || !form.endpoint}
          >
            <IconRefresh size={14} />
            {t("settings.configSync.test")}
          </Button>
          <Button
            variant="primary"
            onClick={() => void run("configure")}
            disabled={busy !== null || !form.endpoint || !vaultPasswordReady}
          >
            <IconCloudDown size={14} />
            {configured ? t("settings.configSync.save") : t("settings.configSync.enable")}
          </Button>
          {configured && !locked ? (
            <Button
              variant="secondary"
              onClick={() => void run("sync")}
              disabled={busy !== null || state?.paused}
            >
              {t("settings.configSync.syncNow")}
            </Button>
          ) : null}
        </div>
        {error ? (
          <div className="settings-config-sync-message error" role="alert">
            {error}
          </div>
        ) : null}
        {notice ? (
          <div className="settings-config-sync-message" role="status">
            {notice}
          </div>
        ) : null}
      </SettingsCard>

      {/* A sync this page started reports itself here, above the cards: the
          first enable is the slowest sync of all, and it runs while the status
          card below has nothing to show yet. */}
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

      {configured ? (
        <>
          <SettingsCard title={t("settings.configSync.statusTitle")}>
            <SettingsRow
              title={t("settings.configSync.statusLabel")}
              detail={
                state?.lastSuccessAt
                  ? t("settings.configSync.lastSuccess", {
                      date: formatStamp(state.lastSuccessAt),
                    })
                  : undefined
              }
            >
              <Badge tone={statusTone(state.status)}>{statusLabel}</Badge>
            </SettingsRow>

            {locked ? (
              <SettingsRow
                title={t("settings.configSync.unlockTitle")}
                description={t("settings.configSync.unlockDescription")}
              >
                <Button
                  variant="primary"
                  onClick={() => void run("unlock")}
                  disabled={busy !== null || !form.backupPassword}
                >
                  <IconShield size={14} />
                  {t("settings.configSync.unlock")}
                </Button>
              </SettingsRow>
            ) : (
              <SettingsRow
                title={t("settings.configSync.pauseTitle")}
                description={t("settings.configSync.pauseDescription")}
              >
                <button
                  type="button"
                  className={cx("settings-toggle", state?.paused && "on")}
                  role="switch"
                  aria-checked={state?.paused === true}
                  aria-label={t("settings.configSync.pauseTitle")}
                  onClick={() => void togglePause()}
                >
                  <span className="settings-toggle-thumb" />
                </button>
              </SettingsRow>
            )}
            {!locked ? (
              <SettingsRow
                title={t("settings.configSync.changePasswordTitle")}
                description={t("settings.configSync.changePasswordDescription")}
              >
                <div className="settings-config-sync-password-actions">
                  <PasswordInput
                    value={form.currentBackupPassword}
                    onChange={(event) =>
                      updateForm("currentBackupPassword", event.target.value)
                    }
                    aria-label={t("settings.configSync.currentBackupPassword")}
                    placeholder={t("settings.configSync.currentBackupPassword")}
                    autoComplete="current-password"
                    showLabel={t("settings.configSync.showPassword")}
                    hideLabel={t("settings.configSync.hidePassword")}
                    disabled={busy !== null}
                  />
                  <PasswordInput
                    value={form.newBackupPassword}
                    onChange={(event) =>
                      updateForm("newBackupPassword", event.target.value)
                    }
                    aria-label={t("settings.configSync.newBackupPassword")}
                    placeholder={t("settings.configSync.newBackupPassword")}
                    autoComplete="new-password"
                    showLabel={t("settings.configSync.showPassword")}
                    hideLabel={t("settings.configSync.hidePassword")}
                    disabled={busy !== null}
                  />
                  <Button
                    variant="secondary"
                    onClick={() => void changePassword()}
                    disabled={
                      busy !== null ||
                      !form.currentBackupPassword ||
                      !form.newBackupPassword
                    }
                  >
                    {t("settings.configSync.changePassword")}
                  </Button>
                </div>
              </SettingsRow>
            ) : null}
          </SettingsCard>

          <SettingsCard
            title={t("settings.configSync.categoriesTitle")}
            description={t("settings.configSync.categoriesDescription")}
          >
            <div className="settings-config-sync-categories">
              {CATEGORIES.map((category) => (
                <label key={category.id} className="settings-config-sync-category">
                  <input
                    type="checkbox"
                    checked={categories[category.id] !== false}
                    onChange={(event) =>
                      setSelection((current) => ({
                        ...current,
                        [category.id]: event.target.checked,
                      }))
                    }
                  />
                  <span>{t(category.label)}</span>
                </label>
              ))}
              <label className="settings-config-sync-category">
                <input
                  type="checkbox"
                  checked={selection.memory}
                  onChange={(event) =>
                    setSelection((current) => ({
                      ...current,
                      memory: event.target.checked,
                    }))
                  }
                />
                <span>{t("settings.configSync.categoryMemory")}</span>
              </label>
              <label className="settings-config-sync-category settings-config-sync-sensitive">
                <input
                  type="checkbox"
                  checked={selection.credentials}
                  onChange={(event) =>
                    setSelection((current) => ({
                      ...current,
                      credentials: event.target.checked,
                    }))
                  }
                />
                <span>{t("settings.configSync.categoryCredentials")}</span>
              </label>
            </div>
            {selection.credentials ? (
              <div className="settings-config-sync-warning">
                {t("settings.configSync.credentialsWarning")}
              </div>
            ) : null}
          </SettingsCard>

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
                          disabled={busy !== null}
                        >
                          {t("settings.configSync.mapFolder")}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void approve(approval.id, approval.digest, false)}
                        disabled={busy !== null}
                      >
                        {t("settings.configSync.reject")}
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => void approve(approval.id, approval.digest, true)}
                        disabled={busy !== null}
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
            <SettingsCard title={t("settings.configSync.previewTitle")}>
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
            </SettingsCard>
          ) : null}

          {state?.mappings.length ? (
            <SettingsCard
              title={t("settings.configSync.mappingsTitle")}
              description={t("settings.configSync.mappingsDescription")}
            >
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
            </SettingsCard>
          ) : null}

          <SettingsCard
            title={t("settings.configSync.historyTitle")}
            description={t("settings.configSync.historyDescription")}
          >
            <div className="settings-config-sync-history-actions">
              <Button
                variant="secondary"
                onClick={() => void loadHistory()}
                disabled={busy !== null || locked}
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
                      disabled={busy !== null || entry.current || locked}
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
          </SettingsCard>

          <SettingsCard>
            <SettingsRow
              title={t("settings.configSync.disconnectTitle")}
              description={t("settings.configSync.disconnectDescription")}
            >
              <Button
                variant="secondary"
                onClick={() => {
                  if (window.confirm(t("settings.configSync.disconnectConfirm"))) {
                    void run("disconnect");
                  }
                }}
                disabled={busy !== null}
              >
                <IconTrash size={14} />
                {t("settings.configSync.disconnect")}
              </Button>
            </SettingsRow>
          </SettingsCard>
        </>
      ) : null}
    </div>
  );
}

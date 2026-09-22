import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ConfigSyncCategory,
  ConfigSyncCategorySelection,
  ConfigSyncHistoryEntry,
  ConfigSyncState,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Badge, Button, Field, Input, PasswordInput, cx } from "../ui";
import { IconCloudDown, IconRefresh, IconShield, IconTrash } from "../icons";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";

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

  const refresh = useCallback(async () => {
    try {
      const next = await api.configSyncGetState();
      setState(next);
      if (next.configured) {
        setForm((current) => ({
          ...current,
          endpoint: next.endpoint ?? current.endpoint,
          username: next.username ?? current.username,
          directory: next.directory ?? current.directory,
          deviceLabel: next.deviceLabel ?? current.deviceLabel,
        }));
        setSelection((current) => ({ ...current, ...next.categories }));
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
    return api.onConfigSyncChanged((next) => setState(next));
  }, [refresh]);

  const updateForm = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const run = async (
    operation: "test" | "configure" | "sync" | "unlock" | "disconnect",
  ) => {
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
          allowInsecureHttp: false,
          categories: selection,
          includeSecrets: selection.credentials,
          includeMemory: selection.memory,
          automaticSync: true,
        });
        setNotice(
          result.conditionalWrites
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
        setForm((current) => ({ ...current, appPassword: "", backupPassword: "" }));
        setSelection(DEFAULT_SELECTION);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refresh();
    } finally {
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

  const statusLabel = useMemo(
    () => t("settings.configSync.status." + (state?.status ?? "notConfigured")),
    [state?.status, t],
  );

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

  return (
    <div className="settings-stack settings-config-sync">
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
            disabled={busy !== null || !form.endpoint || !form.backupPassword}
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

      {configured ? (
        <>
          <SettingsCard title={t("settings.configSync.statusTitle")}>
            <SettingsRow
              title={t("settings.configSync.statusLabel")}
              detail={
                state?.lastSuccessAt
                  ? t("settings.configSync.lastSuccess", {
                      date: state.lastSuccessAt,
                    })
                  : undefined
              }
            >
              <Badge tone={statusTone(state.status)}>{statusLabel}</Badge>
            </SettingsRow>
            {state?.lastError ? (
              <SettingsRow title={t("settings.configSync.lastError")}>
                <span className="settings-config-sync-error">{state.lastError}</span>
              </SettingsRow>
            ) : null}
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
                        {t(
                          "settings.configSync.approvalReason." + approval.reason,
                          { defaultValue: approval.reason },
                        )}
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
                        {entry.createdAt} · {entry.entityCount} {t("settings.configSync.historyItems")}
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

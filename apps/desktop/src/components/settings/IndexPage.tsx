import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, WorkspaceIndexRoot } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button, cx } from "../ui";
import { MetricTile } from "./MetricTile";
import {
  IconActivity,
  IconDatabase,
  IconFileText,
  IconRefresh,
} from "../icons";

type IndexPageProps = {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; root: WorkspaceIndexRoot | null };

/** localStorage flag for the one-time local-only nudge under the index page. */
const NUDGE_DISMISSED_KEY = "pi.index.nudgeDismissed.v1";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

function formatRelative(updatedAt: number): string {
  if (updatedAt <= 0) return "—";
  const deltaSeconds = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  if (deltaSeconds < 60) return `${deltaSeconds}s`;
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m`;
  if (deltaSeconds < 86400) return `${Math.floor(deltaSeconds / 3600)}h`;
  return `${Math.floor(deltaSeconds / 86400)}d`;
}

const STATUS_TONE: Record<WorkspaceIndexRoot["status"], string> = {
  fresh: "ok",
  building: "busy",
  stale: "warn",
  failed: "error",
  partial: "warn",
  disabled: "",
  skipped_over_limit: "warn",
};

export function IndexPage({ settings, saveSettings }: IndexPageProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [busy, setBusy] = useState<"rebuild" | "clear" | null>(null);
  const [actionError, setActionError] = useState(false);
  // One-time note: once dismissed it stays dismissed (localStorage), matching
  // the audit's "never render again once written" requirement.
  const [nudgeVisible, setNudgeVisible] = useState(() => {
    try {
      return localStorage.getItem(NUDGE_DISMISSED_KEY) !== "1";
    } catch {
      return true;
    }
  });
  const grepBoost = settings.indexGrepBoost === true;
  const building = state.kind === "ready" && state.root?.status === "building";

  const dismissNudge = () => {
    try {
      localStorage.setItem(NUDGE_DISMISSED_KEY, "1");
    } catch {
      // Storage unavailable (e.g. locked-down profile): degrade to a
      // session-only dismiss rather than blocking the control.
    }
    setNudgeVisible(false);
  };

  const refresh = useCallback(async () => {
    setState((current) =>
      current.kind === "ready" ? { kind: "ready", root: current.root } : { kind: "loading" },
    );
    try {
      const result = await api.indexStatus();
      setState({ kind: "ready", root: result.roots[0] ?? null });
    } catch {
      setState({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While a background rebuild is in flight, poll once a second — paused
  // whenever the window is hidden, and torn down with the page.
  useEffect(() => {
    if (!building) return;
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      void api.indexStatus().then((result) => {
        const next = result.roots[0];
        if (next) setState({ kind: "ready", root: next });
      });
    };
    const timer = setInterval(poll, 1000);
    return () => clearInterval(timer);
  }, [building]);

  const rebuild = async () => {
    if (busy) return;
    setBusy("rebuild");
    setActionError(false);
    try {
      const result = await api.indexRebuild();
      setState({ kind: "ready", root: result.root });
    } catch {
      setActionError(true);
      void refresh();
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    if (busy) return;
    setBusy("clear");
    setActionError(false);
    try {
      await api.indexClear();
      setState({ kind: "ready", root: null });
    } catch {
      setActionError(true);
      void refresh();
    } finally {
      setBusy(null);
    }
  };

  if (state.kind === "loading") {
    return (
      <div className="settings-stack" role="status">
        <span className="idx-state">{t("index.loading")}</span>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="settings-stack">
        <section className="settings-card-block">
          <div className="settings-panel">
            <div className="settings-row">
              <div className="settings-row-copy">
                <div className="settings-row-title">{t("index.loadErrorTitle")}</div>
                <div className="settings-row-desc">{t("index.loadErrorDesc")}</div>
              </div>
              <div className="settings-row-control">
                <Button onClick={() => void refresh()}>{t("index.retry")}</Button>
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

  const { root } = state;
  const progress = root?.status === "building" ? root.progress : undefined;
  const progressPct =
    progress && progress.filesTotal > 0
      ? Math.min(100, Math.max(0, Math.round((progress.filesDone / progress.filesTotal) * 100)))
      : 0;

  return (
    <div className="settings-stack">
      {/* Sits directly under the page title the settings shell renders. */}
      <p className="idx-subtitle">{t("index.indexSubtitle")}</p>

      <section className="settings-card-block">
        <h3 className="settings-card-heading">{t("index.card.health")}</h3>
        <div className="settings-panel">
          {building ? (
            <div className="idx-progress" role="status">
              {progress ? (
                <>
                  <span className="idx-progress-bar" aria-hidden="true">
                    <span className="idx-progress-fill" style={{ width: `${progressPct}%` }} />
                  </span>
                  <span className="idx-progress-count">
                    {t("index.progressFiles", {
                      done: progress.filesDone.toLocaleString(),
                      total: progress.filesTotal.toLocaleString(),
                    })}
                  </span>
                </>
              ) : (
                // Host gave no counts: an indeterminate busy pill instead of a
                // fake bar, reusing the status language of the tiles below.
                <span className="idx-status busy">{t("index.status.building")}</span>
              )}
              <span className="idx-progress-note">{t("index.progressFallback")}</span>
            </div>
          ) : null}
          {root ? (
            <div className="idx-grid">
              <MetricTile
                icon={<IconActivity size={14} />}
                tone={root.status === "fresh" ? "success" : root.status === "failed" ? "danger" : "warning"}
                label={t("index.card.status")}
                value={
                  <span className={cx("idx-status", STATUS_TONE[root.status])}>
                    {t(`index.status.${root.status}`)}
                  </span>
                }
                caption={t("index.statusDesc")}
              />
              <MetricTile
                icon={<IconFileText size={14} />}
                tone="accent"
                label={t("index.card.files")}
                value={root.fileCount.toLocaleString()}
                badge={
                  root.errorCount > 0 ? (
                    <span className="idx-badge idx-badge-warn">
                      {t("index.card.errors")}: {root.errorCount}
                    </span>
                  ) : undefined
                }
              />
              <MetricTile
                icon={<IconDatabase size={14} />}
                tone="accent"
                label={t("index.card.size")}
                value={formatBytes(root.indexedBytes)}
              />
              <MetricTile
                icon={<IconRefresh size={14} />}
                tone="accent"
                label={t("index.card.updated")}
                value={formatRelative(root.updatedAt)}
              />
            </div>
          ) : (
            <div className="settings-row">
              <div className="settings-row-copy">
                <div className="settings-row-title">{t("index.emptyTitle")}</div>
                <div className="settings-row-desc">{t("index.emptyDesc")}</div>
              </div>
            </div>
          )}
          {root && root.errorCount > 0 && root.lastError ? (
            <div className="idx-error-line" role="status">
              {root.lastError}
            </div>
          ) : null}
          <div className="settings-row">
            <div className="settings-row-copy">
              <div className="settings-row-title">{t("index.actions")}</div>
              <div className="settings-row-desc" id="idx-actions-desc">
                {t("index.actionsDesc")} {t("index.localOnly")}
              </div>
            </div>
            <div className="settings-row-control idx-actions">
              <Button
                variant="primary"
                // Building while the switch is off would only scan the
                // workspace and take up disk for an index nothing uses.
                // The reason sits in the row's own description, not a tooltip:
                // disabled controls do not fire the hover that would show one.
                disabled={busy !== null || !grepBoost}
                aria-busy={busy === "rebuild"}
                aria-describedby="idx-actions-desc"
                onClick={() => void rebuild()}
              >
                <IconDatabase size={14} />
                {busy === "rebuild" ? t("index.rebuilding") : root ? t("index.action.rebuild") : t("index.action.build")}
              </Button>
              <Button
                disabled={busy !== null || !root}
                onClick={() => void clear()}
              >
                {busy === "clear" ? t("index.clearing") : t("index.action.clear")}
              </Button>
            </div>
          </div>
          {actionError ? (
            <div className="idx-error-line" role="status">
              {t("index.actionError")}
            </div>
          ) : null}
        </div>
      </section>

      {/*
        The behaviour switch gets its own "Codebase" section: it is a setting,
        not health telemetry, and the audit flagged it sitting wordlessly
        inside the health card.
      */}
      <section className="settings-card-block">
        <h3 className="settings-card-heading">{t("index.sectionCode")}</h3>
        <div className="settings-panel">
          <div className="settings-row">
            <div className="settings-row-copy">
              <div className="idx-row-title">
                <span className="idx-chip idx-chip-accent" aria-hidden="true">
                  <IconDatabase size={14} />
                </span>
                <span className="settings-row-title">{t("index.grepBoost")}</span>
              </div>
              <div className="settings-row-desc">{t("index.grepBoostDesc")}</div>
            </div>
            <div className="settings-row-control">
              <button
                type="button"
                className={cx("settings-toggle", grepBoost && "on")}
                role="switch"
                aria-checked={grepBoost}
                aria-label={t("index.grepBoost")}
                onClick={() => void saveSettings({ indexGrepBoost: !grepBoost })}
              >
                <span className="settings-toggle-thumb" />
              </button>
            </div>
          </div>
        </div>
      </section>

      {nudgeVisible ? (
        <div className="idx-nudge" role="note">
          <span className="idx-nudge-text">{t("index.nudgeText")}</span>
          <Button variant="ghost" onClick={dismissNudge}>
            {t("index.nudgeDismiss")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

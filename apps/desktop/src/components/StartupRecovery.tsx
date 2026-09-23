import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import {
  buildStartupDiagnostics,
  type StartupPhase,
} from "../lib/startup-watchdog";
import { useAppStore } from "../stores/app-store";
import { BrandLogo } from "./BrandLogo";

type CopyState = "idle" | "copied" | "failed";

/**
 * The window's surface while it has no initial state.
 *
 * Issue #831: a launch that never receives its chats and settings used to stay
 * on the boot surface forever — no menu, no data, and nothing to act on except
 * force-quitting the process. This surface is shown by the startup watchdog when
 * that wait outgrows every bound the startup itself can fail at, and every action
 * on it is available without any backend: retry the wait, take the logs, copy a
 * short report for a bug report, or quit.
 *
 * It is presentation only. The wait it describes keeps running underneath, so a
 * boot that does finish replaces this surface with the shell on its own.
 */
export function StartupRecovery({
  phase,
  waitedMs,
  onRetry,
  retrying,
  down,
}: {
  phase: StartupPhase;
  /** Waited time, read when the report is copied — never during render. */
  waitedMs: () => number;
  onRetry: () => void;
  /** True while the retry the user asked for is still in flight. */
  retrying?: boolean;
  /** What the main process last reported as down, when it reported anything. */
  down?: { component?: string; message?: string } | null;
}) {
  const { t, i18n } = useTranslation();
  const [copyState, setCopyState] = useState<CopyState>("idle");

  if (phase === "starting") return null;
  const stalled = phase === "stalled";

  /**
   * The version the main process knows. Read from main instead of the store,
   * because the store only learns it after a successful startup — which is
   * exactly what did not happen. Bounded, so a wedged bridge cannot hang the
   * copy action it is meant to serve.
   */
  const appVersionFromMain = async (): Promise<string | null> => {
    try {
      const info = await Promise.race([
        api.getVersion(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
      ]);
      return info?.version ?? null;
    } catch {
      return null;
    }
  };

  const copyDiagnostics = async () => {
    const state = useAppStore.getState();
    const report = buildStartupDiagnostics({
      phase,
      elapsedMs: waitedMs(),
      platform: window.piDesktop?.platform ?? "unknown",
      locale: i18n.resolvedLanguage ?? i18n.language ?? null,
      appVersion: state.version?.version ?? (await appVersionFromMain()),
      error: state.error ?? null,
      downComponent: down?.component ?? null,
      downMessage: down?.message ?? null,
    });
    try {
      await navigator.clipboard.writeText(report);
      setCopyState("copied");
    } catch {
      // A refused clipboard is not worth a dialog on a surface this broken; the
      // label reports it and the logs action stays available.
      setCopyState("failed");
    }
  };

  const copyLabel =
    copyState === "copied"
      ? t("startup.diagnosticsCopied")
      : copyState === "failed"
        ? t("startup.diagnosticsFailed")
        : t("startup.copyDiagnostics");

  return (
    <div
      className="startup-recovery"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="startup-recovery-title"
      aria-describedby="startup-recovery-body"
      data-testid="startup-recovery"
      data-phase={phase}
    >
      <div className="startup-recovery-card">
        <div className="startup-recovery-mark" aria-hidden>
          <BrandLogo size={44} />
        </div>
        <h1 id="startup-recovery-title" className="startup-recovery-title">
          {stalled ? t("startup.stalledTitle") : t("startup.slowTitle")}
        </h1>
        <p id="startup-recovery-body" className="startup-recovery-body">
          {stalled ? t("startup.stalledBody") : t("startup.slowBody")}
        </p>
        {stalled ? null : (
          /* The splash's own track: while the wait is still legitimately in
             flight, it has to keep reading as progress, not as a dead screen. */
          <div className="startup-splash-track" aria-hidden>
            <span className="startup-splash-bar" />
          </div>
        )}
        <div className="startup-recovery-actions no-drag">
          {stalled && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={onRetry}
              disabled={retrying}
            >
              {retrying ? t("startup.retrying") : t("errors.action.retry")}
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void api.openLogs().catch(() => undefined)}
          >
            {t("status.openLogs")}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void copyDiagnostics()}
          >
            {/* The label is the only outcome of the copy: announce it. */}
            <span aria-live="polite">{copyLabel}</span>
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              // The answer may never arrive: quitting tears this window down.
              void api.quitApp().catch(() => undefined);
            }}
          >
            {t("tray.quit")}
          </button>
        </div>
      </div>
    </div>
  );
}

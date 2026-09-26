import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  canCancelInstall,
  formatTransfer,
  type PluginInstallJob,
} from "../../features/plugins/install-progress";
import { useAppStore } from "../../stores/app-store";
import { Button, cx, portalOverlay } from "../ui";
import {
  IconCircleCheck,
  IconCopy,
  IconDownload,
  IconRefresh,
  IconTriangleAlert,
} from "../icons";

/** How long a finished install is shown before it closes itself. */
const SUCCESS_DWELL_MS = 2000;

const PHASE_KEYS: Record<PluginInstallJob["phase"], string> = {
  resolve: "plugins.installPhase.resolve",
  download: "plugins.installPhase.download",
  verify: "plugins.installPhase.verify",
  install: "plugins.installPhase.install",
  enable: "plugins.installPhase.enable",
};

type Props = {
  job: PluginInstallJob;
  onCancel: () => Promise<void> | void;
  onRetry: () => Promise<void> | void;
  onClose: () => void;
};

/**
 * The one dialog a manual install or update runs behind.
 *
 * It is opened by the confirmed permission review and then follows what the
 * host reports: the phase it is in, the mirror it is trying, the bytes that
 * arrived. Cancelling is offered only while a download can still be stopped;
 * a failure stays on screen with the mirrors it tried and the option to run
 * the same request again; a success shows and steps aside.
 */
export function PluginInstallDialog({ job, onCancel, onRetry, onClose }: Props) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [hovered, setHovered] = useState(false);
  /**
   * The page hands these callbacks in fresh on every progress report, so the
   * timer and the key listener read them through a ref instead of restarting.
   */
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  const stoppable = canCancelInstall(job);
  const running = job.status === "running";
  // Escape obeys the same rule the cancel button does: a download is not
  // dismissed by accident, a finished install is.
  const escapeLocked = running && (job.phase === "resolve" || job.phase === "download");

  useEffect(() => {
    if (escapeLocked) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [escapeLocked]);

  // A finished install reports itself and then leaves, unless the pointer is
  // still on it: the confirmation is worth reading before it goes.
  useEffect(() => {
    if (job.status !== "success" || hovered) return;
    const handle = window.setTimeout(() => closeRef.current(), SUCCESS_DWELL_MS);
    return () => window.clearTimeout(handle);
  }, [job.status, hovered]);

  const determinate = job.totalBytes > 0;
  const percent = determinate
    ? Math.min(100, Math.max(0, Math.round((job.receivedBytes / job.totalBytes) * 100)))
    : 0;

  const copyDetails = () => {
    const lines = [
      `${job.request.name}${job.request.version ? ` v${job.request.version}` : ""}: ${job.error ?? ""}`,
      ...job.tried.map((mirror) =>
        [
          `- ${mirror.source || t("plugins.installMirrorUnknown")}${mirror.error ? `: ${mirror.error}` : ""}`,
          `  ${mirror.url}`,
        ].join("\n"),
      ),
    ];
    void navigator.clipboard.writeText(lines.join("\n")).then(
      () => showToast(t("plugins.installCopied"), { variant: "success" }),
      () => showToast(t("plugins.installCopyFailed"), { variant: "error" }),
    );
  };

  const outcomeIcon = (size: number) => {
    if (job.status === "success") return <IconCircleCheck size={size} />;
    if (job.status === "failed") return <IconTriangleAlert size={size} />;
    return <IconDownload size={size} />;
  };

  return portalOverlay(
    <div className="plugins-modal-backdrop" role="presentation">
      <div
        className="plugins-modal plugins-install-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("plugins.installDialogTitle", { name: job.request.name })}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <header className="plugins-modal-head">
          <span
            className={cx(
              "plugins-modal-icon",
              job.status === "success" && "is-success",
              job.status === "failed" && "is-error",
            )}
            aria-hidden
          >
            {outcomeIcon(17)}
          </span>
          <div>
            <h2 className="plugins-modal-title">
              {t("plugins.installDialogTitle", { name: job.request.name })}
            </h2>
            {job.request.version ? (
              <p className="plugins-modal-subtitle">
                {t("plugins.installingVersion", { version: job.request.version })}
              </p>
            ) : null}
          </div>
        </header>

        <div className="plugins-modal-body">
          {job.status === "failed" ? (
            <>
              <div className="plugins-install-failure" role="alert">
                <p className="plugins-install-outcome">
                  {t("plugins.installFailed", { name: job.request.name })}
                </p>
                {job.error ? <p className="plugins-install-error">{job.error}</p> : null}
              </div>
              {job.tried.length > 0 ? (
                <div className="plugins-install-tried">
                  <p className="plugins-install-tried-title">
                    {t("plugins.installTriedTitle", { count: job.tried.length })}
                  </p>
                  <ul className="plugins-install-mirrors">
                    {job.tried.map((mirror, index) => (
                      <li key={`${mirror.source}:${mirror.url}:${index}`}>
                        <details className="plugins-install-mirror">
                          <summary className="plugins-install-mirror-head">
                            <span className="plugins-install-mirror-source">
                              {mirror.source || t("plugins.installMirrorUnknown")}
                            </span>
                            {mirror.error ? (
                              <span className="plugins-install-mirror-error">{mirror.error}</span>
                            ) : null}
                          </summary>
                          <code className="plugins-install-mirror-url">{mirror.url}</code>
                        </details>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : job.status === "success" ? (
            <p className="plugins-install-outcome is-success" role="status">
              {t("plugins.installSuccess", { name: job.request.name })}
            </p>
          ) : (
            <>
              <div className="plugins-install-phase" aria-live="polite">
                <span className="plugins-install-phase-label">{t(PHASE_KEYS[job.phase])}</span>
                {job.phase === "download" && job.attempts > 0 ? (
                  <span className="plugins-install-mirror-label">
                    {t("plugins.installMirror", {
                      index: job.attempt,
                      total: job.attempts,
                      source: job.source ?? "",
                    })}
                  </span>
                ) : null}
              </div>
              <div
                className={cx("plugins-install-bar", !determinate && "is-indeterminate")}
                role="progressbar"
                aria-label={t("plugins.installProgressLabel")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={determinate ? percent : undefined}
                aria-valuetext={determinate ? `${percent}%` : undefined}
              >
                <span
                  className="plugins-install-bar-fill"
                  style={determinate ? { width: `${percent}%` } : undefined}
                />
              </div>
              <div className="plugins-install-figures">
                <span className="plugins-install-size">
                  {determinate
                    ? t("plugins.installReceived", {
                        received: formatTransfer(job.receivedBytes),
                        total: formatTransfer(job.totalBytes),
                      })
                    : t("plugins.installReceivedUnknown", {
                        received: formatTransfer(job.receivedBytes),
                      })}
                </span>
                {job.phase === "download" && job.speed > 0 ? (
                  <span className="plugins-install-speed">
                    {t("plugins.installSpeed", { rate: formatTransfer(job.speed) })}
                  </span>
                ) : null}
              </div>
            </>
          )}
        </div>

        <div className="plugins-modal-actions">
          {running ? (
            <Button variant="secondary" disabled={!stoppable} onClick={() => void onCancel()}>
              {job.cancelling ? t("plugins.installCancelling") : t("plugins.installCancel")}
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => onClose()}>
                {t("plugins.installClose")}
              </Button>
              {job.status === "failed" ? (
                <>
                  <Button variant="secondary" onClick={copyDetails}>
                    <IconCopy size={14} aria-hidden />
                    {t("plugins.installCopyDetails")}
                  </Button>
                  <Button variant="primary" onClick={() => void onRetry()}>
                    <IconRefresh size={14} aria-hidden />
                    {t("plugins.installRetry")}
                  </Button>
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>,
  );
}

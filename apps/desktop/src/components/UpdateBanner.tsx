import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { UpdateState } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { useUpdateState } from "../hooks/use-update-state";
import { Button } from "./ui";
import { IconClose, IconCloudDown, IconExternal } from "./icons";

/**
 * Ambient update notice in the main pane's top safe area. Appears when an
 * update is ready to install (in-app mode) or newly detected (manual mode);
 * silent otherwise. The Settings → Info tab owns explicit checks and status.
 * When Main attaches dual-locale release notes, they appear under the status
 * message as a compact "What's new" list (D164).
 */
export function UpdateBanner() {
  const { t } = useTranslation();
  const update = useUpdateState();
  const [dismissedState, setDismissedState] = useState<string | null>(null);

  if (!update?.availableVersion) return null;
  const stateKey = `${update.availableVersion}:${update.status}`;
  if (stateKey === dismissedState) return null;

  const visible =
    update.status === "downloaded" ||
    update.status === "downloading" ||
    (update.status === "available" && update.mode === "manual");
  if (!visible) return null;

  const message = bannerMessage(update, t);
  const progress = Math.max(0, Math.min(100, update.progressPercent ?? 0));
  const notes = update.releaseNotes?.trim() || null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="update-notice"
      data-update-status={update.status}
    >
      <div className="update-notice-icon" aria-hidden="true">
        <IconCloudDown className="size-4" />
      </div>

      <div className="update-notice-body">
        <div className="update-notice-title">{t("updates.title")}</div>
        <div className="update-notice-message">{message}</div>

        {notes ? (
          <div className="update-notice-notes">
            <div className="update-notice-notes-label">{t("updates.whatsNew")}</div>
            <pre className="update-notice-notes-body">{notes}</pre>
          </div>
        ) : null}

        {update.status === "downloading" && (
          <div
            className="update-notice-progress"
            role="progressbar"
            aria-label={message}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress)}
          >
            <span style={{ width: `${progress}%` }} />
          </div>
        )}

        <div className="update-notice-actions">
          {update.status === "downloaded" && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void api.updatesInstall().catch(() => undefined)}
            >
              {t("updates.restart")}
            </Button>
          )}
          {update.status === "available" && update.mode === "manual" && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                void api.updatesOpenReleases().catch(() => undefined)
              }
            >
              <IconExternal className="size-3.5" />
              {t("updates.viewRelease")}
            </Button>
          )}
        </div>
      </div>

      <button
        type="button"
        aria-label={t("updates.dismiss")}
        className="update-notice-dismiss"
        onClick={() => setDismissedState(stateKey)}
      >
        <IconClose className="size-3.5" />
      </button>
    </div>
  );
}

function bannerMessage(
  update: UpdateState,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (update.status === "downloading") {
    return t("updates.downloading", { percent: update.progressPercent ?? 0 });
  }
  if (update.status === "downloaded") {
    return t("updates.downloaded", { version: update.availableVersion });
  }
  return t("updates.available", { version: update.availableVersion });
}

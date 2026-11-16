/**
 * Appearance rows for the user-supplied boot animation (D679 / ADR 0338).
 *
 * The animation is a file, not a value, so the first job of these rows is to
 * make the folder findable: the status line names what the next launch will
 * play — or says nothing is there — and the action opens the folder, creating
 * it on the way. Without that, a feature configured by dropping a file into a
 * hidden directory is undiscoverable.
 *
 * Neither row can change the running window. The descriptor is a window
 * creation argument, so like the translucency switch beside it, a change lands
 * on the next launch; the copy says so rather than implying a live preview.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, StartupAnimationStatus } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { SettingsRow } from "../../features/settings/primitives";
import { SettingsToggle } from "../ui";

export function StartupAnimationRows({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  // Absent means on: the feature is dormant without a file, so a default of
  // off would make dropping one in look broken.
  const enabled = settings.startupAnimation?.enabled !== false;
  const skipWhenReady = settings.startupAnimation?.skipWhenReady === true;
  // `null` until the scan answers; an unreadable folder keeps the status line
  // empty rather than claiming no file is there.
  const [status, setStatus] = useState<StartupAnimationStatus | null>(null);

  // Both the mount scan and the post-open rescan resolve after an await, so
  // neither may publish into an unmounted row.
  const mountedRef = useRef(true);
  const refresh = useCallback(() => {
    void api
      .startupAnimationStatus()
      .then((next) => {
        if (mountedRef.current) setStatus(next);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  const openFolder = useCallback(() => {
    void api
      .openStartupAnimationFolder()
      // A user opens the folder to put a file in it, so re-scan when they come
      // back instead of leaving a status line that predates the drop.
      .then(() => {
        refresh();
      })
      .catch(() => undefined);
  }, [refresh]);

  return (
    <>
      <SettingsRow
        title={t("settings.startupAnimation")}
        description={t("settings.startupAnimationDesc")}
        detail={
          <span className="startup-animation-status">
            <span className="startup-animation-status-file">
              {status
                ? (status.fileName ?? t("settings.startupAnimationNone"))
                : ""}
            </span>
            <button
              type="button"
              className="settings-inline-action"
              onClick={openFolder}
            >
              {t("settings.startupAnimationFolder")}
            </button>
          </span>
        }
      >
        <SettingsToggle
          checked={enabled}
          label={t("settings.startupAnimation")}
          onChange={() =>
            void saveSettings({
              startupAnimation: { ...settings.startupAnimation, enabled: !enabled },
            })
          }
        />
      </SettingsRow>
      {/*
        Gated by the master switch, and kept out of the tree entirely while the
        animation is off: it describes a moment that cannot happen then. The
        stored value survives, so turning the animation back on restores the
        previous choice instead of resetting it.
      */}
      {enabled ? (
        <SettingsRow
          title={t("settings.startupAnimationSkipWhenReady")}
          description={t("settings.startupAnimationSkipWhenReadyDesc")}
        >
          <SettingsToggle
            checked={skipWhenReady}
            label={t("settings.startupAnimationSkipWhenReady")}
            onChange={() =>
              void saveSettings({
                startupAnimation: {
                  ...settings.startupAnimation,
                  skipWhenReady: !skipWhenReady,
                },
              })
            }
          />
        </SettingsRow>
      ) : null}
    </>
  );
}

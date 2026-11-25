import { useTranslation } from "react-i18next";
import { BrandLogo } from "./BrandLogo";
import { cx } from "./ui";

/** Full-window boot surface shown until host/settings bootstrap finishes. */
export function StartupSplash({ exiting = false }: { exiting?: boolean }) {
  const { t } = useTranslation();

  return (
    <div
      className={cx("startup-splash", exiting && "is-exiting")}
      role="status"
      aria-live="polite"
      aria-busy={!exiting}
      data-testid="startup-splash"
    >
      <div className="startup-splash-card">
        <div className="startup-splash-mark" aria-hidden>
          <BrandLogo size={64} />
        </div>
        <div className="startup-splash-copy">
          <div className="startup-splash-name">{t("app.shellName")}</div>
          <div className="startup-splash-tagline">{t("settings.aboutTagline")}</div>
        </div>
        <div className="startup-splash-track" aria-hidden>
          <span className="startup-splash-bar" />
        </div>
        <span className="sr-only">{t("app.starting")}</span>
      </div>
    </div>
  );
}

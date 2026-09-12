import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  CHANGELOG,
  normalizeChangelogVersion,
  resolveChangelogLocale,
} from "@pi-desktop/shared";
import { Badge, cx } from "./ui";
import { IconClose } from "./icons";
import { TooltipButton } from "./ui";

export function ReleaseNotesDialog({
  currentVersion,
  availableVersion,
  onClose,
}: {
  currentVersion?: string;
  availableVersion?: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const locale = resolveChangelogLocale(
    i18n.resolvedLanguage ?? i18n.language,
  );
  const entries = CHANGELOG[locale];
  const normalizedCurrent = normalizeChangelogVersion(currentVersion);
  const normalizedAvailable = normalizeChangelogVersion(availableVersion);

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
    [locale],
  );

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="overlay release-notes-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog release-notes-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="release-notes-title"
        aria-describedby="release-notes-summary"
      >
        <header className="release-notes-header">
          <div className="release-notes-heading">
            <h2 id="release-notes-title">{t("updates.releaseNotes")}</h2>
            <p id="release-notes-summary">
              {t("updates.releaseCount", { count: entries.length })}
            </p>
          </div>
          <TooltipButton
            ref={closeRef}
            type="button"
            className="icon-btn release-notes-close"
            tooltip={t("updates.closeReleaseNotes")}
            ariaLabel={t("updates.closeReleaseNotes")}
            onClick={onClose}
          >
            <IconClose size={16} />
          </TooltipButton>
        </header>

        <div className="release-notes-list selectable">
          {entries.map((entry) => {
            const isAvailable = entry.version === normalizedAvailable;
            const isCurrent = entry.version === normalizedCurrent;
            return (
              <article
                key={entry.version}
                className={cx(
                  "release-notes-version",
                  (isAvailable || isCurrent) && "is-highlighted",
                )}
                data-release-version={entry.version}
              >
                <div className="release-notes-version-header">
                  <div>
                    <h3>
                      {t("updates.versionLabel", { version: entry.version })}
                    </h3>
                    {entry.date ? (
                      <time dateTime={entry.date}>
                        {dateFormatter.format(
                          new Date(`${entry.date}T00:00:00Z`),
                        )}
                      </time>
                    ) : null}
                  </div>
                  <div className="release-notes-badges">
                    {isAvailable ? (
                      <Badge tone="success">{t("updates.availableBadge")}</Badge>
                    ) : null}
                    {isCurrent ? (
                      <Badge>{t("updates.currentBadge")}</Badge>
                    ) : null}
                  </div>
                </div>
                <ul>
                  {entry.highlights.map((highlight) => (
                    <li key={highlight}>{highlight}</li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}

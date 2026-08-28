import { useTranslation } from "react-i18next";

/**
 * Keeps the conversation pane occupied while a destination session hydrates.
 * The shapes follow the transcript's user/assistant rhythm without exposing
 * the previous session's content during navigation.
 */
export function SessionLoadingSkeleton() {
  const { t } = useTranslation();

  return (
    <div
      className="session-loading-skeleton thread-wrap"
      data-testid="session-loading-skeleton"
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">{t("chat.loadingSession")}</span>
      <div
        className="session-loading-skeleton-scroll thread-scroll"
        aria-hidden="true"
      >
        <div className="thread-content session-loading-skeleton-content">
          <div className="session-loading-skeleton-group is-user">
            <span className="session-loading-skeleton-line is-long" />
            <span className="session-loading-skeleton-line is-short" />
          </div>
          <div className="session-loading-skeleton-group is-assistant">
            <span className="session-loading-skeleton-line is-wide" />
            <span className="session-loading-skeleton-line is-medium" />
            <span className="session-loading-skeleton-line is-short" />
          </div>
          <div className="session-loading-skeleton-group is-user is-second-user">
            <span className="session-loading-skeleton-line is-medium" />
          </div>
          <div className="session-loading-skeleton-group is-assistant is-last-assistant">
            <span className="session-loading-skeleton-line is-wide" />
            <span className="session-loading-skeleton-line is-long" />
            <span className="session-loading-skeleton-line is-medium" />
          </div>
        </div>
      </div>
    </div>
  );
}

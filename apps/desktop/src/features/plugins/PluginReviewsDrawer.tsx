/**
 * The public review drawer: a read-only list of what the plugin centre shows,
 * opened from the detail sheet's ratings summary.
 *
 * It is an independent surface at the same dialog level as the detail sheet —
 * it slides over it while the sheet stays mounted underneath, so closing the
 * drawer returns to the exact reading position it covered. Reviews are written
 * on the plugin centre; the desktop never signs in, never posts, and never
 * offers signed-in actions, so the composer is a permanently greyed field and
 * the one call to action is a real link out to the centre's page.
 */
import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button, Textarea, TooltipButton, cx } from "../../components/ui";
import { IconExternal, IconStar, IconX } from "../../components/icons";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { formatDate } from "./model";
import {
  REVIEW_SENTIMENTS,
  REVIEW_SORT_LABEL_KEYS,
  REVIEW_SORTS,
  REVIEW_SENTIMENT_LABEL_KEYS,
  formatReviewRating,
  type ReviewSentiment,
  type ReviewSort,
} from "./reviews";
import { ReviewSummaryBlock } from "./presentation";
import { usePluginReviews } from "./usePluginReviews";

/** What Tab can reach inside the drawer's own surface. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => element.getAttribute("aria-hidden") !== "true",
  );
}

export function PluginReviewsDrawer({
  pluginId,
  pluginName,
  onClose,
}: {
  pluginId: string;
  pluginName: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const showToast = useAppStore((state) => state.showToast);
  const {
    state,
    sentiment,
    sort,
    setSentiment,
    setSort,
    loadMore,
    retry,
    reviewUrl,
  } = usePluginReviews(pluginId);
  const dialogRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // The drawer is the top layer when it mounts: focus it so Escape and Tab
  // start here, and let the sheet restore its own opener on close.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  /**
   * Escape and Tab belong to the top layer. Escape is claimed before anything
   * under the drawer sees it (the detail sheet also stands down while this
   * surface is open, see usePluginsPage); Tab cycles inside the dialog, so
   * keyboard focus can never reach the covered sheet or the page behind it.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = focusableWithin(root);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && root.contains(active);
      if (!inside) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  /** Open the centre's page in the system browser; report a failure. */
  const openReviewLink = () => {
    void (async () => {
      try {
        await api.browserOpenExternal(reviewUrl);
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), {
          variant: "error",
        });
      }
    })();
  };

  const reviewSummary = state.summary;
  const showSummary = !!reviewSummary && reviewSummary.ratingCount > 0;
  const showList = state.reviews.length > 0;
  const failedWithoutRows = state.status === "error" && !showList;

  return (
    <div className="plugins-reviews-layer">
      <button
        type="button"
        className="plugins-reviews-scrim"
        aria-label={t("plugins.reviews.close")}
        onClick={onClose}
      />
      <aside
        ref={dialogRef}
        className="plugins-reviews"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="plugins-reviews-head">
          <h2 className="plugins-reviews-title" id={titleId}>
            {t("plugins.reviews.title", { name: pluginName })}
          </h2>
          <TooltipButton
            type="button"
            className="plugins-icon-btn"
            ariaLabel={t("plugins.reviews.close")}
            tooltip={t("plugins.reviews.close")}
            onClick={onClose}
          >
            <IconX size={15} />
          </TooltipButton>
        </header>

        <div className="plugins-reviews-body">
          {showSummary && reviewSummary ? (
            <ReviewSummaryBlock summary={reviewSummary} locale={locale} />
          ) : null}

          <div className="plugins-reviews-controls">
            <div
              className="plugins-reviews-filters"
              role="group"
              aria-label={t("plugins.reviews.filterLabel")}
            >
              {REVIEW_SENTIMENTS.map((value: ReviewSentiment) => (
                <button
                  key={value}
                  type="button"
                  className={cx("plugins-filter", sentiment === value && "active")}
                  aria-pressed={sentiment === value}
                  onClick={() => setSentiment(value)}
                >
                  {t(REVIEW_SENTIMENT_LABEL_KEYS[value])}
                </button>
              ))}
            </div>
            <div
              className="plugins-reviews-filters"
              role="group"
              aria-label={t("plugins.reviews.sortLabel")}
            >
              {REVIEW_SORTS.map((value: ReviewSort) => (
                <button
                  key={value}
                  type="button"
                  className={cx("plugins-filter", sort === value && "active")}
                  aria-pressed={sort === value}
                  onClick={() => setSort(value)}
                >
                  {t(REVIEW_SORT_LABEL_KEYS[value])}
                </button>
              ))}
            </div>
          </div>

          {state.status === "loading" && !showList ? (
            <p className="plugins-reviews-state" role="status">
              {t("plugins.reviews.loading")}
            </p>
          ) : failedWithoutRows ? (
            <div className="plugins-reviews-state" role="alert">
              <p className="plugins-reviews-state-title">
                {t("plugins.reviews.loadFailed")}
              </p>
              {state.error ? (
                <p className="plugins-reviews-state-detail">{state.error}</p>
              ) : null}
              <Button variant="secondary" size="sm" onClick={retry}>
                {t("plugins.reviews.retry")}
              </Button>
            </div>
          ) : !showList ? (
            <p className="plugins-reviews-state">{t("plugins.reviews.empty")}</p>
          ) : (
            <ul className="plugins-reviews-list" aria-label={t("plugins.reviews.listAria")}>
              {state.reviews.map((review) => (
                <li key={review.id} className="plugins-review">
                  <div className="plugins-review-head">
                    <span className="plugins-review-author">{review.authorName}</span>
                    <span
                      className="plugins-review-rating"
                      role="img"
                      aria-label={t("plugins.reviews.reviewRatingAria", {
                        rating: formatReviewRating(review.ratingHalfStars),
                      })}
                    >
                      <IconStar
                        size={12}
                        style={{ fill: "currentColor" }}
                        aria-hidden="true"
                      />
                      <span>{formatReviewRating(review.ratingHalfStars)}</span>
                    </span>
                  </div>
                  <div className="plugins-review-meta">
                    <span>{formatDate(review.createdAt, locale)}</span>
                    {review.pluginVersion ? (
                      <>
                        <span className="plugins-dot" aria-hidden>
                          ·
                        </span>
                        {/* The author asserts this; it is not an installed
                            version, so it is labelled as what it is. */}
                        <span>
                          {t("plugins.reviews.reviewVersion", {
                            version: review.pluginVersion,
                          })}
                        </span>
                      </>
                    ) : null}
                    {review.editedAt ? (
                      <>
                        <span className="plugins-dot" aria-hidden>
                          ·
                        </span>
                        <span>{t("plugins.reviews.edited")}</span>
                      </>
                    ) : null}
                    {review.helpfulCount > 0 ? (
                      <>
                        <span className="plugins-dot" aria-hidden>
                          ·
                        </span>
                        <span>
                          {t("plugins.reviews.helpfulCount", {
                            count: review.helpfulCount,
                          })}
                        </span>
                      </>
                    ) : null}
                  </div>
                  <p className="plugins-review-body">{review.body}</p>
                </li>
              ))}
            </ul>
          )}

          {state.error && showList ? (
            <div className="plugins-reviews-state is-inline" role="alert">
              <span className="plugins-reviews-state-detail">{state.error}</span>
              <Button variant="secondary" size="sm" onClick={retry}>
                {t("plugins.reviews.retry")}
              </Button>
            </div>
          ) : null}

          {state.nextCursor ? (
            <div className="plugins-reviews-more">
              <Button
                variant="secondary"
                size="sm"
                disabled={state.loadingMore}
                onClick={loadMore}
              >
                {state.loadingMore
                  ? t("plugins.reviews.loading")
                  : t("plugins.reviews.loadMore")}
              </Button>
            </div>
          ) : null}
        </div>

        <div className="plugins-reviews-composer">
          <Textarea
            className="plugins-reviews-composer-field"
            disabled
            rows={2}
            aria-label={t("plugins.reviews.composeHint")}
            placeholder={t("plugins.reviews.composeHint")}
          />
          {/* A real link: the OS browser opens the centre's page, where a
              signed-in account can post. The desktop never writes reviews. */}
          <a
            className="plugins-reviews-write"
            href={reviewUrl}
            onClick={(event) => {
              event.preventDefault();
              openReviewLink();
            }}
            onAuxClick={(event) => {
              // Middle-click only: a right-click belongs to the platform
              // menu, never to opening the page.
              if (event.button !== 1) return;
              event.preventDefault();
              openReviewLink();
            }}
          >
            <IconExternal size={13} aria-hidden="true" />
            {t("plugins.reviews.composeCta")}
          </a>
        </div>
      </aside>
    </div>
  );
}

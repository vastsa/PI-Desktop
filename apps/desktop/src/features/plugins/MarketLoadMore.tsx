import { useEffect, useRef } from "react";
import type { TFunction } from "i18next";
import { Button } from "../../components/ui";
import { MARKET_PREFETCH_MARGIN } from "./market-paging";

/**
 * The end of the marketplace list. While more pages exist it asks for the next
 * one as it approaches the viewport, and it always carries a button that does
 * the same, for keyboard users and for retrying after a failed page. A failed
 * page pauses the automatic request until the button is used.
 */
export function MarketLoadMore({
  t,
  loaded,
  total,
  hasMore,
  loading,
  failed,
  onLoadMore,
}: {
  t: TFunction;
  loaded: number;
  total: number;
  hasMore: boolean;
  loading: boolean;
  failed: boolean;
  onLoadMore: () => void;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;
  const armed = hasMore && !loading && !failed;

  useEffect(() => {
    const node = sentinel.current;
    if (!armed || !node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMoreRef.current();
      },
      { rootMargin: MARKET_PREFETCH_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
    // `loaded` re-arms the observer after each page, so a sentinel that is
    // still in view after an append asks for the next page too.
  }, [armed, loaded]);

  if (total === 0) return null;
  return (
    <div ref={sentinel} className="plugins-load-more">
      <span className="plugins-result-count" aria-live="polite">
        {t("plugins.loadedCount", { count: loaded, total })}
      </span>
      {hasMore ? (
        <Button variant="secondary" size="sm" disabled={loading} onClick={onLoadMore}>
          {loading ? t("plugins.loadingMore") : failed ? t("plugins.loadMoreRetry") : t("plugins.loadMore")}
        </Button>
      ) : null}
    </div>
  );
}

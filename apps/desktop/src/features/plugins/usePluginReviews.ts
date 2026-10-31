/**
 * Reads the public review list for one plugin: first page, sentiment filter,
 * sort, and cursor paging. The centre is optional infrastructure — an
 * unreachable or older service fails this surface alone and never touches
 * install or update paths — so every failure lands as a retryable error here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import {
  applyNextReviewPage,
  applyReviewPage,
  beginReviewLoad,
  beginReviewLoadMore,
  effectiveReviewUrl,
  failReviewLoad,
  initialReviewListState,
  reviewQuery,
  reviewQueryKey,
  type ReviewListState,
  type ReviewSentiment,
  type ReviewSort,
} from "./reviews";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function usePluginReviews(pluginId: string) {
  const [sentiment, setSentiment] = useState<ReviewSentiment>("all");
  const [sort, setSort] = useState<ReviewSort>("newest");
  const [state, setState] = useState<ReviewListState>(initialReviewListState);
  /**
   * Request identity: switching query or pressing retry invalidates every
   * answer still in flight, and the pure helpers refuse a mismatched key
   * again so a race cannot smuggle another filter's rows into the list.
   */
  const generation = useRef(0);

  // A drawer that closes mid-request must not walk an old answer back into a
  // component that no longer exists: bumping the generation on unmount makes
  // every in-flight response stale.
  useEffect(() => {
    return () => {
      generation.current += 1;
    };
  }, []);

  const requestFirstPage = useCallback(
    (key: string, query: { sentiment: ReviewSentiment; sort: ReviewSort }) => {
      const request = ++generation.current;
      void (async () => {
        try {
          const page = await api.marketReviews(
            reviewQuery(pluginId, query.sentiment, query.sort),
          );
          if (generation.current !== request) return;
          setState((current) => applyReviewPage(current, key, page, pluginId));
        } catch (error) {
          if (generation.current !== request) return;
          setState((current) => failReviewLoad(current, key, errorMessage(error)));
        }
      })();
    },
    [pluginId],
  );

  useEffect(() => {
    const key = reviewQueryKey(pluginId, sentiment, sort);
    setState((current) => beginReviewLoad(current, key));
    requestFirstPage(key, { sentiment, sort });
  }, [pluginId, sentiment, sort, requestFirstPage]);

  const loadMore = useCallback(() => {
    const cursor = state.nextCursor;
    const key = state.key;
    if (!cursor || !key || state.loadingMore) return;
    setState((current) => beginReviewLoadMore(current));
    const request = ++generation.current;
    void (async () => {
      try {
        const page = await api.marketReviews(reviewQuery(pluginId, sentiment, sort, cursor));
        if (generation.current !== request) return;
        setState((current) => applyNextReviewPage(current, key, page));
      } catch (error) {
        if (generation.current !== request) return;
        setState((current) => failReviewLoad(current, key, errorMessage(error)));
      }
    })();
  }, [pluginId, sentiment, sort, state.key, state.loadingMore, state.nextCursor]);

  /** Retry whichever request failed: the first page, or the next one. */
  const retry = useCallback(() => {
    if (state.reviews.length && state.nextCursor) {
      loadMore();
      return;
    }
    const key = reviewQueryKey(pluginId, sentiment, sort);
    setState((current) => beginReviewLoad(current, key));
    requestFirstPage(key, { sentiment, sort });
  }, [
    loadMore,
    pluginId,
    requestFirstPage,
    sentiment,
    sort,
    state.nextCursor,
    state.reviews.length,
  ]);

  return {
    state,
    sentiment,
    sort,
    setSentiment,
    setSort,
    loadMore,
    retry,
    /** The write link: the centre's page URL, or the official fallback. */
    reviewUrl: state.reviewUrl ?? effectiveReviewUrl(pluginId, null),
  };
}

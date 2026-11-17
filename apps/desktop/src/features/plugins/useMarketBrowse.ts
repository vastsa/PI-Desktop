import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MarketBrowseResult,
  MarketCategoryFacet,
  MarketPluginSummary,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { usePluginBrowseState } from "./browse-state";
import { isClientVisibleMarketPlugin } from "./model";
import { MARKET_PAGE_SIZE, appendPage, categoryChips, hasMorePages } from "./market-paging";

/** Typing waits this long before it asks; sorting and filtering do not. */
export const MARKET_QUERY_DEBOUNCE_MS = 240;

type Feed = {
  items: MarketPluginSummary[];
  loadedPages: number;
  total: number;
  pageCount: number;
  facets: MarketCategoryFacet[];
  source: MarketBrowseResult["source"] | null;
};

const EMPTY_FEED: Feed = {
  items: [],
  loadedPages: 0,
  total: 0,
  pageCount: 0,
  facets: [],
  source: null,
};

/**
 * The marketplace as one growing list: the first page arrives when the query,
 * category, sort or language changes, and every further page is appended as
 * the user scrolls toward the end.
 *
 * A change of what is browsed starts a new generation. Answers carry the
 * generation they were asked for, so a first page for an older query, or a
 * next page still loading when the query changed, is dropped rather than mixed
 * into the new list. Only one next-page request runs at a time, and a failed
 * one stops automatic loading until the user retries, so an offline scroll
 * does not turn into a stream of errors.
 */
export function useMarketBrowse({
  active,
  locale,
  onError,
}: {
  active: boolean;
  locale: string;
  onError: (error: unknown) => void;
}) {
  const { query, category, sort, seed } = usePluginBrowseState();
  const [feed, setFeed] = useState<Feed>(EMPTY_FEED);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const generation = useRef(0);
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const moreInFlight = useRef(false);
  const lastQuery = useRef<string | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const ask = useCallback(
    (page: number) =>
      api.marketBrowse({ query, category, sort, seed, page, pageSize: MARKET_PAGE_SIZE }),
    [query, category, sort, seed],
  );

  /** Start a new generation from the first page. */
  const reload = useCallback(async () => {
    const id = ++generation.current;
    moreInFlight.current = false;
    setLoadingMore(false);
    setLoadMoreFailed(false);
    setLoading(true);
    try {
      const answer = await ask(1);
      if (id !== generation.current) return;
      setFeed({
        items: appendPage([], answer.plugins.filter(isClientVisibleMarketPlugin)),
        loadedPages: 1,
        total: answer.total,
        pageCount: answer.pageCount,
        facets: answer.categories,
        source: answer.source,
      });
    } catch (error) {
      if (id === generation.current) onErrorRef.current(error);
    } finally {
      if (id === generation.current) setLoading(false);
    }
  }, [ask]);

  /** Append the next page, if there is one and nothing else is loading it. */
  const loadMore = useCallback(async () => {
    const current = feedRef.current;
    if (moreInFlight.current || !hasMorePages(current.loadedPages, current.pageCount)) return;
    const id = generation.current;
    moreInFlight.current = true;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    try {
      const answer = await ask(current.loadedPages + 1);
      if (id !== generation.current) return;
      setFeed((previous) => ({
        ...previous,
        items: appendPage(previous.items, answer.plugins.filter(isClientVisibleMarketPlugin)),
        loadedPages: previous.loadedPages + 1,
        total: answer.total,
        pageCount: answer.pageCount,
        // A page from the snapshot after a remote first page still says so.
        source: answer.source === "local" ? "local" : previous.source,
      }));
    } catch (error) {
      if (id !== generation.current) return;
      setLoadMoreFailed(true);
      onErrorRef.current(error);
    } finally {
      if (id === generation.current) {
        moreInFlight.current = false;
        setLoadingMore(false);
      }
    }
  }, [ask]);

  // `locale` re-reads because plugin labels are resolved in the host
  // (ADR 0160); otherwise the previous language stays on the cards.
  useEffect(() => {
    if (!active) return;
    // Retire whatever is in flight now, not when the debounce fires: an answer
    // for the previous query must not land during the typing window.
    generation.current += 1;
    const typed = lastQuery.current !== null && lastQuery.current !== query && query.trim() !== "";
    lastQuery.current = query;
    const handle = window.setTimeout(() => void reload(), typed ? MARKET_QUERY_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(handle);
  }, [active, reload, locale, query]);

  // Leaving the tab abandons any answer still in flight.
  useEffect(() => {
    if (active) return;
    generation.current += 1;
    moreInFlight.current = false;
    setLoading(false);
    setLoadingMore(false);
  }, [active]);

  /**
   * Reflect an install on its card in place: reloading would throw away every
   * page the user scrolled through to reach it.
   */
  const markInstalled = useCallback((id: string, version?: string) => {
    setFeed((previous) => ({
      ...previous,
      items: previous.items.map((item) =>
        item.id === id
          ? {
              ...item,
              installed: true,
              installedVersion: version ?? item.latestVersion,
              updateAvailable: false,
            }
          : item,
      ),
    }));
  }, []);

  const categories = useMemo(() => categoryChips(feed.facets, category), [feed.facets, category]);

  return {
    market: feed.items,
    marketLoading: loading,
    marketLoadingMore: loadingMore,
    marketLoadMoreFailed: loadMoreFailed,
    marketTotal: feed.total,
    marketHasMore: hasMorePages(feed.loadedPages, feed.pageCount),
    browseOrigin: feed.source,
    categories,
    reloadMarket: reload,
    loadMoreMarket: loadMore,
    markMarketInstalled: markInstalled,
  };
}

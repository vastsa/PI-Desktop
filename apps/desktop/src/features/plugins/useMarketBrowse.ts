import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MarketBrowseResult, MarketPluginSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { usePluginBrowseState } from "./browse-state";
import { isClientVisibleMarketPlugin } from "./model";
import { MARKET_PAGE_SIZE, categoryChips } from "./market-paging";

/** Typing waits this long before it asks; paging, sorting and filtering do not. */
export const MARKET_QUERY_DEBOUNCE_MS = 240;

/**
 * One page of the marketplace, driven by the persisted browse choices.
 *
 * Only the newest request may land: a slow answer for an older query or page
 * is dropped rather than painted over the page the user has since asked for.
 * A page that no longer exists — the catalog shrank under a filter — snaps to
 * the last page instead of showing an empty grid with a pager beside it.
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
  const { query, category, sort, page, seed, setPage } = usePluginBrowseState();
  const [result, setResult] = useState<MarketBrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const lastQuery = useRef<string | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const load = useCallback(async () => {
    const id = ++sequence.current;
    setLoading(true);
    try {
      const answer = await api.marketBrowse({
        query,
        category,
        sort,
        seed,
        page,
        pageSize: MARKET_PAGE_SIZE,
      });
      if (id !== sequence.current) return;
      if (answer.pageCount > 0 && page > answer.pageCount) {
        setPage(answer.pageCount);
        return;
      }
      setResult(answer);
    } catch (error) {
      if (id === sequence.current) onErrorRef.current(error);
    } finally {
      if (id === sequence.current) setLoading(false);
    }
  }, [query, category, sort, seed, page, setPage]);

  // `locale` re-reads the page because plugin labels are resolved in the host
  // (ADR 0160); otherwise the previous language stays on the cards.
  useEffect(() => {
    if (!active) return;
    // Retire whatever is in flight now, not when the debounce fires: an answer
    // for the previous query must not land during the typing window.
    sequence.current += 1;
    const typed = lastQuery.current !== null && lastQuery.current !== query && query.trim() !== "";
    lastQuery.current = query;
    const handle = window.setTimeout(() => void load(), typed ? MARKET_QUERY_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(handle);
  }, [active, load, locale, query]);

  // Leaving the tab abandons any answer still in flight.
  useEffect(() => {
    if (active) return;
    sequence.current += 1;
    setLoading(false);
  }, [active]);

  const plugins: MarketPluginSummary[] = useMemo(
    () => (result?.plugins ?? []).filter(isClientVisibleMarketPlugin),
    [result],
  );
  const categories = useMemo(
    () => categoryChips(result?.categories ?? [], category),
    [result, category],
  );

  return {
    browse: result,
    market: plugins,
    marketLoading: loading,
    marketTotal: result?.total ?? 0,
    marketPage: result?.page ?? page,
    marketPageCount: result?.pageCount ?? 0,
    browseOrigin: result?.source ?? null,
    categories,
    reloadMarket: load,
  };
}

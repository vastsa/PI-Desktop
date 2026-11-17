import type {
  MarketBrowseSort,
  MarketCategoryFacet,
  MarketPluginSummary,
} from "@pi-desktop/shared";

/** Cards fetched per request: four rows of the widest grid, six of the narrowest. */
export const MARKET_PAGE_SIZE = 24;

/** Start the next page this far before the end of the list comes into view. */
export const MARKET_PREFETCH_MARGIN = "600px 0px";

export const MARKET_SORTS: readonly MarketBrowseSort[] = [
  "recommended",
  "popular",
  "updated",
  "name",
];

export const MARKET_SORT_LABEL_KEYS: Record<MarketBrowseSort, string> = {
  recommended: "plugins.sortRecommended",
  popular: "plugins.sortPopular",
  updated: "plugins.sortUpdated",
  name: "plugins.sortName",
};

/** A positive 31-bit seed, so it survives JSON and every integer check. */
export function newBrowseSeed(random: () => number = Math.random): number {
  return 1 + Math.floor(random() * 0x7ffffffe);
}

/**
 * Append a page to what is already on screen. A plugin that moved between
 * pages while the user scrolled (a publish reordered the catalog) is kept
 * where it was first shown rather than appearing twice.
 */
export function appendPage(
  loaded: readonly MarketPluginSummary[],
  page: readonly MarketPluginSummary[],
): MarketPluginSummary[] {
  const seen = new Set(loaded.map((plugin) => plugin.id));
  const next = [...loaded];
  for (const plugin of page) {
    if (seen.has(plugin.id)) continue;
    seen.add(plugin.id);
    next.push(plugin);
  }
  return next;
}

/** Whether another page exists after `loadedPages` pages. */
export function hasMorePages(loadedPages: number, pageCount: number): boolean {
  return loadedPages > 0 && loadedPages < pageCount;
}

/**
 * Category chips for the current answer. The selected category stays visible
 * even when the current query no longer matches it, so the user can always
 * see — and clear — the filter that is in effect.
 */
export function categoryChips(
  facets: readonly MarketCategoryFacet[],
  selected: string,
): MarketCategoryFacet[] {
  const chips = [...facets];
  if (selected && !chips.some((chip) => chip.id.toLowerCase() === selected.toLowerCase())) {
    chips.unshift({ id: selected, count: 0 });
  }
  return chips;
}

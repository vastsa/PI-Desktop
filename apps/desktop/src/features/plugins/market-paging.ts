import type { MarketBrowseSort, MarketCategoryFacet } from "@pi-desktop/shared";

/** Cards per marketplace page: four rows of the widest grid, six of the narrowest. */
export const MARKET_PAGE_SIZE = 24;

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

export type PageItem = number | "gap";

/**
 * Page buttons for a pager: always the first and last page, the current page
 * with one neighbour each side, and a gap wherever pages are skipped. A gap
 * that would hide a single page shows that page instead, so the row never
 * reads "1 … 3".
 */
export function paginationItems(page: number, pageCount: number): PageItem[] {
  if (pageCount <= 0) return [];
  const current = Math.min(Math.max(1, page), pageCount);
  const shown = new Set<number>([1, pageCount, current - 1, current, current + 1]);
  const pages = [...shown].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);
  const items: PageItem[] = [];
  let previous = 0;
  for (const n of pages) {
    if (n - previous === 2) items.push(previous + 1);
    else if (n - previous > 2) items.push("gap");
    items.push(n);
    previous = n;
  }
  return items;
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

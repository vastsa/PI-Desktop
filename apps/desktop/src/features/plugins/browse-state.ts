import { create } from "zustand";
import type { MarketBrowseSort } from "@pi-desktop/shared";
import type { TabId } from "./model";
import { newBrowseSeed } from "./market-paging";

/**
 * Retain only browsing choices across route unmounts, never dialogs or work.
 *
 * Changing what is searched, filtered or ordered starts again at page one; the
 * seed lives for the app session, so the recommended order a user paged
 * through is still the same order when they come back to the tab.
 */
export const usePluginBrowseState = create<{
  tab: TabId;
  installedQuery: string;
  query: string;
  category: string;
  sort: MarketBrowseSort;
  page: number;
  seed: number;
  setTab: (tab: TabId) => void;
  setInstalledQuery: (installedQuery: string) => void;
  setQuery: (query: string) => void;
  setCategory: (category: string) => void;
  setSort: (sort: MarketBrowseSort) => void;
  setPage: (page: number) => void;
}>((set) => ({
  tab: "installed",
  installedQuery: "",
  query: "",
  category: "",
  sort: "recommended",
  page: 1,
  seed: newBrowseSeed(),
  setTab: (tab) => set({ tab }),
  setInstalledQuery: (installedQuery) => set({ installedQuery }),
  setQuery: (query) => set((state) => (state.query === query ? {} : { query, page: 1 })),
  setCategory: (category) =>
    set((state) => (state.category === category ? {} : { category, page: 1 })),
  setSort: (sort) => set((state) => (state.sort === sort ? {} : { sort, page: 1 })),
  setPage: (page) => set({ page: Math.max(1, Math.floor(page)) }),
}));

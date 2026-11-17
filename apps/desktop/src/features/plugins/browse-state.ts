import { create } from "zustand";
import type { MarketBrowseSort } from "@pi-desktop/shared";
import type { TabId } from "./model";
import { newBrowseSeed } from "./market-paging";

/**
 * Retain only browsing choices across route unmounts, never dialogs or work.
 *
 * The seed lives for the app session, so the recommended order a user scrolled
 * through is still the same order when they come back to the tab. How many
 * pages are loaded is not a choice and is not kept here.
 */
export const usePluginBrowseState = create<{
  tab: TabId;
  installedQuery: string;
  query: string;
  category: string;
  sort: MarketBrowseSort;
  seed: number;
  setTab: (tab: TabId) => void;
  setInstalledQuery: (installedQuery: string) => void;
  setQuery: (query: string) => void;
  setCategory: (category: string) => void;
  setSort: (sort: MarketBrowseSort) => void;
}>((set) => ({
  tab: "installed",
  installedQuery: "",
  query: "",
  category: "",
  sort: "recommended",
  seed: newBrowseSeed(),
  setTab: (tab) => set({ tab }),
  setInstalledQuery: (installedQuery) => set({ installedQuery }),
  setQuery: (query) => set({ query }),
  setCategory: (category) => set({ category }),
  setSort: (sort) => set({ sort }),
}));

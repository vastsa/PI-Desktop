import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/*
 * Marketplace paging: the pure pager/facet helpers, the browse-state
 * transitions every control goes through, and the panel as it renders one
 * page of a host answer. Loaded through Vite's SSR module graph so the real
 * TypeScript sources are what run.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function withModules(run) {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const paging = await server.ssrLoadModule("/src/features/plugins/market-paging.ts");
    const { usePluginBrowseState } = await server.ssrLoadModule("/src/features/plugins/browse-state.ts");
    const { MarketplacePanel } = await server.ssrLoadModule("/src/features/plugins/MarketplacePanel.tsx");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    await run({ paging, usePluginBrowseState, MarketplacePanel, t: i18n.t.bind(i18n) });
  } finally {
    await server.close();
  }
}

test("appending a page keeps the first position of a plugin that moved between pages", async () => {
  await withModules(({ paging: { appendPage, hasMorePages, categoryChips, newBrowseSeed } }) => {
    const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };
    assert.deepEqual(appendPage([a, b], [b, c]).map((p) => p.id), ["a", "b", "c"]);
    assert.deepEqual(appendPage([], [a]).map((p) => p.id), ["a"]);
    assert.equal(hasMorePages(0, 3), false, "nothing loaded yet is not 'more'");
    assert.equal(hasMorePages(1, 3), true);
    assert.equal(hasMorePages(3, 3), false);
    const facets = [{ id: "Tools", count: 3 }];
    assert.deepEqual(categoryChips(facets, "tools"), facets);
    assert.deepEqual(categoryChips(facets, "Writing"), [{ id: "Writing", count: 0 }, ...facets]);
    assert.equal(newBrowseSeed(() => 0), 1);
    assert.equal(newBrowseSeed(() => 1 - Number.EPSILON), 0x7ffffffe);
  });
});

test("browse choices are kept and the session seed never changes", async () => {
  await withModules(({ usePluginBrowseState }) => {
    const state = () => usePluginBrowseState.getState();
    const seed = state().seed;
    assert.ok(Number.isInteger(seed) && seed > 0);
    state().setQuery("todo");
    state().setCategory("Tools");
    state().setSort("popular");
    assert.deepEqual([state().query, state().category, state().sort], ["todo", "Tools", "popular"]);
    assert.equal(state().seed, seed);
  });
});

function card(id, extra = {}) {
  return {
    id,
    name: id,
    description: `${id} description`,
    author: "acme",
    latestVersion: "1.0.0",
    updatedAt: "2026-01-01T00:00:00Z",
    categories: ["Tools"],
    permissionSummary: [],
    installable: true,
    ...extra,
  };
}

function model(t, overrides = {}) {
  const market = [card("acme.one"), card("acme.two")];
  return {
    t,
    locale: "en",
    query: "",
    setQuery: () => {},
    refreshMarket: async () => {},
    categories: [{ id: "Tools", count: 30 }, { id: "Writing", count: 4 }],
    category: "",
    setCategory: () => {},
    sort: "recommended",
    setSort: () => {},
    marketLoading: false,
    marketLoadingMore: false,
    marketLoadMoreFailed: false,
    marketTotal: 30,
    marketHasMore: true,
    loadMoreMarket: async () => {},
    browseOrigin: "remote",
    market,
    visibleMarket: market,
    installedById: new Map(),
    selectedId: null,
    openDetail: async () => {},
    isPluginBusy: () => false,
    queueInstall: () => {},
    reviewSummaries: {},
    reviewTickers: {},
    ...overrides,
  };
}

test("the list renders its facets, sort, total and an end-of-list loader", async () => {
  await withModules(({ MarketplacePanel, t }) => {
    const html = renderToStaticMarkup(createElement(MarketplacePanel, model(t)));
    assert.match(html, />Tools<span class="plugins-filter-count">30<\/span>/);
    assert.match(html, /role="radio" aria-checked="true" class="plugins-sort-btn active">Recommended</);
    assert.match(html, /30 plugins/);
    assert.equal((html.match(/class="plugins-card"/g) ?? []).length, 2);
    assert.match(html, /class="plugins-load-more"/);
    assert.match(html, /2 of 30 loaded/);
    assert.match(html, />Load more</);
    assert.doesNotMatch(html, /plugins-pager|plugins-source-chip/);
  });
});

test("the loader reports loading and retry, and drops its button at the end", async () => {
  await withModules(({ MarketplacePanel, t }) => {
    const loading = renderToStaticMarkup(createElement(MarketplacePanel, model(t, { marketLoadingMore: true })));
    assert.match(loading, /disabled="">Loading…</);
    const failed = renderToStaticMarkup(createElement(MarketplacePanel, model(t, { marketLoadMoreFailed: true })));
    assert.match(failed, />Retry loading</);
    const done = renderToStaticMarkup(
      createElement(MarketplacePanel, model(t, { marketHasMore: false, marketTotal: 2 })),
    );
    assert.match(done, /2 of 2 loaded/);
    assert.doesNotMatch(done, />Load more</);
  });
});

test("a snapshot answer is labelled and a refresh dims the list", async () => {
  await withModules(({ MarketplacePanel, t }) => {
    const html = renderToStaticMarkup(
      createElement(MarketplacePanel, model(t, { browseOrigin: "local", marketLoading: true })),
    );
    assert.match(html, /class="plugins-source-chip">Saved catalog</);
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /plugins-card-grid is-refreshing/);
  });
});

test("an empty result offers to clear the filters that produced it", async () => {
  await withModules(({ MarketplacePanel, t }) => {
    const html = renderToStaticMarkup(
      createElement(
        MarketplacePanel,
        model(t, { query: "nothing", market: [], visibleMarket: [], marketTotal: 0, marketHasMore: false }),
      ),
    );
    assert.match(html, /No plugins matched your search/);
    assert.match(html, /Clear search/);
    assert.doesNotMatch(html, /plugins-load-more/);
  });
});

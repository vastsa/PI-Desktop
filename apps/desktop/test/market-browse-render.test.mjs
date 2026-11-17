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

test("the pager shows first, last and the current neighbourhood, never a one-page gap", async () => {
  await withModules(({ paging: { paginationItems } }) => {
    assert.deepEqual(paginationItems(1, 0), []);
    assert.deepEqual(paginationItems(1, 1), [1]);
    assert.deepEqual(paginationItems(1, 5), [1, 2, "gap", 5]);
    assert.deepEqual(paginationItems(3, 5), [1, 2, 3, 4, 5]);
    assert.deepEqual(paginationItems(5, 10), [1, "gap", 4, 5, 6, "gap", 10]);
    assert.deepEqual(paginationItems(10, 10), [1, "gap", 9, 10]);
    // An out-of-range page is clamped rather than producing a dangling button.
    assert.deepEqual(paginationItems(40, 3), [1, 2, 3]);
  });
});

test("the selected category stays a chip even when the query no longer matches it", async () => {
  await withModules(({ paging: { categoryChips, newBrowseSeed } }) => {
    const facets = [{ id: "Tools", count: 3 }];
    assert.deepEqual(categoryChips(facets, ""), facets);
    assert.deepEqual(categoryChips(facets, "tools"), facets);
    assert.deepEqual(categoryChips(facets, "Writing"), [{ id: "Writing", count: 0 }, ...facets]);
    assert.equal(newBrowseSeed(() => 0), 1);
    assert.equal(newBrowseSeed(() => 1 - Number.EPSILON), 0x7ffffffe);
  });
});

test("changing what is searched, filtered or ordered starts again at page one", async () => {
  await withModules(({ usePluginBrowseState }) => {
    const state = () => usePluginBrowseState.getState();
    const seed = state().seed;
    assert.ok(Number.isInteger(seed) && seed > 0);
    state().setPage(4);
    assert.equal(state().page, 4);
    state().setQuery("todo");
    assert.equal(state().page, 1);
    state().setPage(3);
    state().setQuery("todo");
    assert.equal(state().page, 3, "re-applying the same query keeps the page");
    state().setCategory("Tools");
    assert.equal(state().page, 1);
    state().setPage(2);
    state().setSort("popular");
    assert.equal(state().page, 1);
    state().setPage(0);
    assert.equal(state().page, 1, "a page below one is clamped");
    assert.equal(state().seed, seed, "the session seed never changes while browsing");
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
    setPage: () => {},
    marketLoading: false,
    marketTotal: 30,
    marketPage: 2,
    marketPageCount: 2,
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

test("one page renders with its facets, sort, total and pager", async () => {
  await withModules(({ MarketplacePanel, t }) => {
    const html = renderToStaticMarkup(createElement(MarketplacePanel, model(t)));
    assert.match(html, />Tools<span class="plugins-filter-count">30<\/span>/);
    assert.match(html, /role="radio" aria-checked="true" class="plugins-sort-btn active">Recommended</);
    assert.match(html, />Popular</);
    assert.match(html, /30 plugins/);
    assert.equal((html.match(/class="plugins-card"/g) ?? []).length, 2);
    assert.match(html, /<nav class="plugins-pager" aria-label="Pages">/);
    assert.match(html, /aria-label="Page 2" aria-current="page"/);
    assert.match(html, /aria-label="Next page" disabled=""/);
    assert.match(html, /Page 2 of 2/);
    assert.doesNotMatch(html, /plugins-source-chip/);
  });
});

test("a snapshot answer is labelled, a refresh dims the page, and one page hides the pager", async () => {
  await withModules(({ MarketplacePanel, t }) => {
    const html = renderToStaticMarkup(
      createElement(
        MarketplacePanel,
        model(t, { browseOrigin: "local", marketLoading: true, marketPage: 1, marketPageCount: 1 }),
      ),
    );
    assert.match(html, /class="plugins-source-chip">Saved catalog</);
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /plugins-card-grid is-refreshing/);
    assert.doesNotMatch(html, /plugins-pager/);
  });
});

test("an empty page offers to clear the filters that produced it", async () => {
  await withModules(({ MarketplacePanel, t }) => {
    const html = renderToStaticMarkup(
      createElement(
        MarketplacePanel,
        model(t, {
          query: "nothing",
          market: [],
          visibleMarket: [],
          marketTotal: 0,
          marketPage: 1,
          marketPageCount: 0,
        }),
      ),
    );
    assert.match(html, /No plugins matched your search/);
    assert.match(html, /Clear search/);
    assert.doesNotMatch(html, /plugins-pager/);
  });
});

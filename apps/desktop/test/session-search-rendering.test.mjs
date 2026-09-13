import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

test("session result rendering keeps literal snippets safe and selectable in every locale", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { SearchSessionResults } = await server.ssrLoadModule(
      "/src/components/SearchSessionResults.tsx",
    );
    for (const [locale, catalog] of Object.entries(catalogs)) {
      const i18n = createInstance();
      await i18n.init({ lng: locale, resources: { [locale]: { translation: catalog } } });
      const html = renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(SearchSessionResults, {
            query: "needle",
            active: 2,
            runningSessions: {},
            onActivate() {},
            onSelect() {},
            groups: [
              {
                key: "today",
                rows: [
                  {
                    session: { id: "one", title: "Investigation" },
                    optionIndex: 1,
                    projectLabel: "demo",
                    archived: true,
                    hit: {
                      metadataMatch: false,
                      messageCount: 125,
                      matches: [
                        {
                          messageId: "u",
                          role: "user",
                          createdAt: "2026-09-13T00:00:00Z",
                          snippet: "<img src=x> needle",
                        },
                        {
                          messageId: "a",
                          role: "assistant",
                          createdAt: "2026-09-13T00:01:00Z",
                          snippet: "The NEEDLE is here",
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          }),
        ),
      );
      assert.equal((html.match(/role="option"/g) ?? []).length, 3, locale);
      assert.match(html, /id="global-search-option-2"[^>]*aria-selected="true"/);
      assert.match(html, /&lt;img src=x&gt;/);
      assert.doesNotMatch(html, /<img\s/);
      assert.match(html, /<mark class="search-hit">needle<\/mark>/);
      assert.match(html, /<mark class="search-hit">NEEDLE<\/mark>/);
      assert.ok(html.includes("125"), locale);
      assert.ok(html.includes(catalog.search.user), locale);
      assert.ok(html.includes(catalog.search.assistant), locale);
      assert.ok(html.includes(catalog.search.archived), locale);
    }
  } finally {
    await server.close();
  }
});

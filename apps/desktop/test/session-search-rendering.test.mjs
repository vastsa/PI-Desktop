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
    const selections = [];
    function ClickProbe(props) {
      const element = SearchSessionResults({
        ...props,
        onSelect: (row, messageId) => selections.push([row.session.id, messageId]),
      });
      const visit = (node) => {
        if (Array.isArray(node)) return node.forEach(visit);
        if (!node?.props) return;
        if (node.type === "button" && node.props.role === "option") node.props.onClick();
        visit(node.props.children);
      };
      visit(element);
      return element;
    }
    for (const [locale, catalog] of Object.entries(catalogs)) {
      selections.length = 0;
      const i18n = createInstance();
      await i18n.init({ lng: locale, resources: { [locale]: { translation: catalog } } });
      const html = renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(ClickProbe, {
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
      assert.deepEqual(selections, [["one", undefined], ["one", "u"], ["one", "a"]], locale);
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
    const { transcriptSearchRanges } = await server.ssrLoadModule("/src/lib/transcript-search-highlight.ts");
    const originalDocument = globalThis.document;
    const originalFilter = globalThis.NodeFilter;
    try {
      const textNodes = ["prefix ".repeat(15_000), "NEE", "DLE 中文"].map((textContent) => ({
        textContent, parentElement: { closest: () => null },
      }));
      globalThis.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
      globalThis.document = {
        createTreeWalker: () => {
          let index = 0;
          return { nextNode: () => textNodes[index++] ?? null };
        },
        createRange: () => ({
          setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
          setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; },
        }),
      };
      const ranges = transcriptSearchRanges({}, "needle");
      assert.equal(ranges.length, 1);
      assert.equal(ranges[0].startContainer, textNodes[1]);
      assert.equal(ranges[0].startOffset, 0);
      assert.equal(ranges[0].endContainer, textNodes[2]);
      assert.equal(ranges[0].endOffset, 3);
      assert.equal(textNodes[1].textContent, "NEE", "highlighting leaves the original DOM text intact");
    } finally {
      globalThis.document = originalDocument;
      globalThis.NodeFilter = originalFilter;
    }
  } finally {
    await server.close();
  }
});

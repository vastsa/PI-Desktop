/**
 * Issue #986: the "@" menu lists delegates, and they head the file rows.
 *
 * The real panel renders against every shipped catalog (Vite SSR +
 * `renderToStaticMarkup`), because the contract here is visual and semantic: a
 * localized group label, the `@name` the user will type, and the accessible name
 * that identifies the delegate. Row order is asserted on the markup, because
 * keyboard navigation depends on agents being selectable first.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * Load the real panel with the portal wrapper swapped for a test double, so a
 * static render can see the rows it builds. The panel's own grouping, row
 * markup and accessible names are the code under test; only the positioning
 * layer is replaced.
 */
async function loadPanel() {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: {
      alias: [
        {
          // Absolute so the match survives the import's leading "./".
          find: /.*[\\/]settings[\\/]AnchoredMenu$/,
          replacement: `${here}helpers/anchored-menu-stub.tsx`,
        },
      ],
    },
  });
  try {
    const module = await server.ssrLoadModule(
      "/src/components/ComposerAutocomplete.tsx",
    );
    return module.ComposerAutocomplete;
  } finally {
    await server.close();
  }
}

const agentItem = (name, description) => ({
  kind: "agent",
  agent: { name, description },
  match: { score: 1, ranges: [] },
});
const fileItem = (path) => ({
  kind: "path",
  entry: { path, kind: "file" },
  match: { score: 1, ranges: [] },
});

/** The panel with the given rows, highlighted at the first one. */
function menu(items) {
  return {
    open: true,
    mode: "file",
    query: "e",
    items,
    hasItems: true,
    highlight: 0,
    setHighlight() {},
    truncated: false,
    noWorkspace: false,
    close() {},
  };
}

/** Render the panel under one locale. */
async function render(Panel, locale, catalog, items) {
  const i18n = createInstance();
  await i18n.init({ lng: locale, resources: { [locale]: { translation: catalog } } });
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Panel, {
        anchorRef: { current: null },
        ac: menu(items),
        onAccept() {},
      }),
    ),
  );
}

test("the @ menu heads files with a localized Agents group", async () => {
  const Panel = await loadPanel();
  const groups = new Set();
  for (const [locale, catalog] of Object.entries(catalogs)) {
    groups.add(String(catalog.chat.agentGroup));
    const html = await render(Panel, locale, catalog, [
      agentItem("explorer", "Sweeps the codebase."),
      fileItem("src/explore.ts"),
    ]);

    // The delegate is offered with the exact token that will be typed, and its
    // description travels with it.
    assert.match(html, /@explorer/, locale);
    assert.match(html, /Sweeps the codebase\./, locale);
    // The group is labelled in this locale, and heads the list rather than
    // trailing the file rows.
    assert.ok(
      html.indexOf(String(catalog.chat.agentGroup)) < html.indexOf("explore.ts"),
      `${locale}: the Agents group must precede the file rows`,
    );
    // Each row carries a per-row accessible name, so the two kinds stay
    // distinguishable to a screen reader.
    assert.match(html, /aria-label="@explorer — Sweeps the codebase\."/, locale);
    assert.match(html, /aria-label="explore.ts — src\/explore.ts"/, locale);
    // The menu is a listbox of options, so a screen reader can count the rows.
    assert.match(html, /role="listbox"/, locale);
    assert.equal((html.match(/role="option"/g) ?? []).length, 2, locale);
  }
  // Each locale names the group in its own words, so the label is real copy
  // rather than one English string repeated nine times.
  assert.ok(groups.size > 1, `expected per-locale group labels, saw ${groups.size}`);
});

test("a workspace-less session still offers delegates", async () => {
  const Panel = await loadPanel();
  // `noWorkspace` is the "open a project" empty state. It must not appear while
  // a delegate is on offer, or delegation would look unavailable without one.
  const html = await render(Panel, "en", catalogs.en, [
    agentItem("explorer", "Sweeps the codebase."),
  ]);
  assert.match(html, /@explorer/);
  assert.doesNotMatch(html, /Open a project to reference files/);
});

test("the menu opens without stalling on a catalog read that never happens", async () => {
  const { composerSourcesReady } = await import(
    "../src/hooks/use-composer-autocomplete.ts"
  );
  // Agent mode, project open: both sources must land before the menu opens, or
  // the user sees a menu that briefly contains nothing.
  assert.equal(
    composerSourcesReady({ mode: "agent", hasWorkspace: true, filesLoaded: false, agentsResolved: true }),
    false,
  );
  assert.equal(
    composerSourcesReady({ mode: "agent", hasWorkspace: true, filesLoaded: true, agentsResolved: false }),
    false,
  );
  assert.equal(
    composerSourcesReady({ mode: "agent", hasWorkspace: true, filesLoaded: true, agentsResolved: true }),
    true,
  );
  // Agent mode without a project: there is no file index to wait for.
  assert.equal(
    composerSourcesReady({ mode: "agent", hasWorkspace: false, filesLoaded: false, agentsResolved: true }),
    true,
  );
  // Plan/Goal never start a catalog read, so the agent source must not gate the
  // file menu — this is the regression that would hide file completion there.
  for (const mode of ["plan", "goal"]) {
    assert.equal(
      composerSourcesReady({ mode, hasWorkspace: true, filesLoaded: false, agentsResolved: false }),
      false,
    );
    assert.equal(
      composerSourcesReady({ mode, hasWorkspace: true, filesLoaded: true, agentsResolved: false }),
      true,
      `${mode}: the file menu must not wait on a read that never starts`,
    );
  }
});

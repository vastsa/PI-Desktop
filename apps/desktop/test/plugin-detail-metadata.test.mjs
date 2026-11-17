import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/*
 * What the detail sheet shows for a plugin the catalog describes fully.
 *
 * The catalog is camelCase; the entry used to be parsed as snake_case, so the
 * readme, the safety notes and the publisher were always absent and the sheet
 * rendered none of them however complete the published document was. This
 * renders the real sheet from a detail built the way the host builds it.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function withSheet(run) {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { PluginDetailSheet } = await server.ssrLoadModule(
      "/src/features/plugins/PluginDetailSheet.tsx",
    );
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    await run({ PluginDetailSheet, t: i18n.t.bind(i18n) });
  } finally {
    await server.close();
  }
}

function detail(overrides = {}) {
  return {
    id: "pi.rich",
    name: "Rich",
    description: "has metadata",
    author: "Rich Author",
    publisherId: "tioit-wang",
    trust: "community",
    latestVersion: "1.0.0",
    updatedAt: "2026-01-01T00:00:00Z",
    categories: ["themes"],
    permissionSummary: ["ui.theme"],
    permissions: ["ui.theme"],
    safetyNotes: "Reads nothing outside its own folder.",
    readmeMarkdown: "# Rich\n\nA readme the sheet should render.",
    versions: [
      {
        version: "1.0.0",
        publishedAt: "2026-01-01T00:00:00Z",
        shasum: "ab".repeat(32),
        url: "packages/pi.rich-1.0.0.piplug",
        sizeBytes: 12,
        permissions: ["ui.theme"],
      },
    ],
    ...overrides,
  };
}

function model(t, overrides = {}) {
  const current = detail(overrides.detail);
  return {
    t,
    locale: "en",
    selectedId: current.id,
    closeDetail: () => {},
    detail: current,
    detailLoading: false,
    activeVersion: current.versions[0],
    installTarget: "1.0.0",
    detailWithdrawn: false,
    detailPackagePending: false,
    detailUpToDate: false,
    detailPermissions: ["ui.theme"],
    installedDetail: undefined,
    isPluginBusy: () => false,
    queueInstall: () => {},
    setSelectedVersion: () => {},
    reviewSummaries: {},
    reviewsStatus: "ready",
    reviewsId: null,
    openReviews: () => {},
    closeReviews: () => {},
  };
}

test("the sheet renders the published readme, safety notes and publisher", async () => {
  await withSheet(({ PluginDetailSheet, t }) => {
    const html = renderToStaticMarkup(createElement(PluginDetailSheet, model(t)));
    assert.match(html, /# Rich|A readme the sheet should render\./, "readme missing");
    assert.match(html, /Reads nothing outside its own folder\./, "safety notes missing");
    assert.match(html, /Publisher tioit-wang/, "publisher missing");
  });
});

test("a catalog entry without those fields renders without them", async () => {
  await withSheet(({ PluginDetailSheet, t }) => {
    const bare = detail({ publisherId: undefined, safetyNotes: undefined, readmeMarkdown: undefined });
    const html = renderToStaticMarkup(createElement(PluginDetailSheet, model(t, { detail: bare })));
    assert.doesNotMatch(html, /Publisher /, "publisher must not render when absent");
    assert.doesNotMatch(html, /Reads nothing/, "safety notes must not render when absent");
  });
});

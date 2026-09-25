/**
 * Settings ▸ Remote Hosts ▸ Sync models (D628).
 *
 * Renders the confirm dialog against a seeded store: it offers only the rows
 * main will accept, leads with and pre-checks the local default, and nothing
 * syncs without a choice. The page offers the action on SSH hosts only and
 * never syncs on its own.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

function provider(id, overrides = {}) {
  return {
    id,
    name: `Provider ${id}`,
    vendorKey: "openai",
    type: "native",
    protocol: "openai-responses",
    enabled: true,
    authKind: "api_key",
    hasSecret: true,
    models: [{ id: "m" }],
    supportsReasoning: false,
    supportedThinkingLevels: ["off"],
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

/** `[name, checked]` for every provider row, in render order. */
function providerRows(html) {
  return [...html.matchAll(/<label class="settings-config-sync-category">([\s\S]*?)<\/label>/g)].map(
    ([, row]) => [row.match(/<span>([^<]+)<\/span>/)?.[1], /checked=""/.test(row)],
  );
}

test("the sync dialog offers only syncable providers and leads with the local default", async () => {
  const previousDocument = globalThis.document;
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { SyncProvidersDialog } = await server.ssrLoadModule(
      "/src/features/remote/SyncProvidersDialog.tsx",
    );
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    // No document: the dialog renders in place instead of through a portal.
    delete globalThis.document;
    const render = (state) => {
      Object.assign(useAppStore.getInitialState(), state);
      return renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(SyncProvidersDialog, {
            hostKey: "box",
            hostLabel: "Box",
            onClose() {},
            onSynced() {},
            onError() {},
          }),
        ),
      );
    };
    const copy = catalogs.en.settings.remoteHosts;

    const html = render({
      providers: [
        provider("keyed"),
        provider("oauth", { hasOauth: true }),
        provider("signin", { authKind: "oauth" }),
        provider("plugin", { ownerPluginId: "plug" }),
        provider("disabled", { enabled: false }),
        provider("keyless", { hasSecret: false }),
        provider("local", { authKind: "none", hasSecret: false }),
        provider("default"),
      ],
      settings: { defaultProviderId: "default" },
    });
    assert.deepEqual(providerRows(html), [
      ["Provider default", true],
      ["Provider keyed", false],
      ["Provider local", false],
    ]);
    assert.ok(html.includes("Sync models to Box"));
    assert.ok(html.includes(copy.syncDescription), "the dialog says the keys travel");
    assert.equal(html.split(`>${copy.syncLocalDefault}<`).length - 1, 1);
    assert.match(html, /remote-sync-provider-default"><input type="checkbox" checked=""/);
    assert.match(html, new RegExp(`<button[^>]*class="[^"]*primary[^"]*"[^>]*>${copy.syncAction}<`));
    assert.doesNotMatch(html, new RegExp(`<button[^>]*disabled=""[^>]*>${copy.syncAction}<`));

    // A default that cannot sync is neither listed nor pre-selected.
    const unsyncableDefault = render({
      providers: [provider("keyed"), provider("oauth", { hasOauth: true })],
      settings: { defaultProviderId: "oauth" },
    });
    assert.deepEqual(providerRows(unsyncableDefault), [["Provider keyed", false]]);
    assert.match(unsyncableDefault, new RegExp(`<button[^>]*disabled=""[^>]*>${copy.syncAction}<`));

    const empty = render({ providers: [provider("oauth", { hasOauth: true })], settings: {} });
    assert.deepEqual(providerRows(empty), []);
    assert.ok(empty.includes(copy.syncEmpty));
    assert.match(empty, new RegExp(`<button[^>]*disabled=""[^>]*>${copy.syncAction}<`));
  } finally {
    await server.close();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("the dialog sends the chosen rows in list order and only on confirm", () => {
  const dialog = read("../src/features/remote/SyncProvidersDialog.tsx");
  assert.match(dialog, /providers\.filter\(isSyncableProvider\)/);
  assert.match(
    dialog,
    /providerIds: candidates\.filter\(\(p\) => selected\.has\(p\.id\)\)\.map\(\(p\) => p\.id\)/,
  );
  assert.equal(dialog.match(/api\.syncRemoteHostProviders\(/g)?.length, 1);
  assert.match(dialog, /if \(busyRef\.current \|\| selected\.size === 0\) return;/);
});

test("the page offers sync on connected SSH hosts and never syncs unasked", () => {
  const page = read("../src/components/settings/RemoteHostsPage.tsx");
  assert.match(
    page,
    /host\.transport === "ssh" \? \(\s*<Button[\s\S]*?disabled=\{!host\.connected \|\| removing === host\.hostKey\}[\s\S]*?onClick=\{\(\) => setSyncHost\(host\)\}/,
  );
  assert.doesNotMatch(page, /api\.syncRemoteHostProviders/);
  // The bootstrap success path hints at the sync instead of running it.
  assert.match(
    page,
    /t\("settings\.remoteHosts\.sshSucceeded"[\s\S]*?t\("settings\.remoteHosts\.syncHint"/,
  );
});

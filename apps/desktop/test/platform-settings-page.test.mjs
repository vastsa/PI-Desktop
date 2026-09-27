/** The real settings page must not surface ineligible rows from a mixed host snapshot. */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { AI_PLATFORM_BASE_URL, AI_PLATFORM_VENDOR_KEY, bindingForCustomModel } from "@pi-desktop/shared";
import { createServer } from "vite";

test("mixed provider snapshots show only platform rows without changing stored providers or defaults", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { ModelConfigPage } = await server.ssrLoadModule("/src/components/settings/ModelConfigPage.tsx");
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    const i18n = i18next.createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const row = (id, patch = {}) => ({
      id, name: id, vendorKey: AI_PLATFORM_VENDOR_KEY,
      baseUrl: AI_PLATFORM_BASE_URL, type: "openai_compatible",
      protocol: "openai_compatible", authKind: "api_key_and_base_url",
      enabled: true, hasSecret: true, hasOauth: false,
      models: [bindingForCustomModel(`${id}-model`)], defaultModelId: `${id}-model`,
      apiStyle: "chat_completions", supportsReasoning: false, supportedThinkingLevels: [],
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...patch,
    });
    const providers = [
      row("platform-first"),
      row("legacy-openai", { vendorKey: "openai", baseUrl: "https://api.openai.com/v1" }),
      row("platform-second", { apiStyle: "responses" }),
      row("legacy-subscription", { authKind: "oauth", hasOauth: true }),
      row("plugin-row", { ownerPluginId: "example-plugin" }),
      row("foreign-endpoint", { baseUrl: "https://other.invalid/v1" }),
      row("unsupported-format", { apiStyle: "google_generative_ai" }),
      row("platform-paused", { enabled: false }),
      row("platform-needs-key", { hasSecret: false }),
    ];
    const settings = {
      defaultProviderId: "platform-second", defaultModelId: "platform-second-model",
      imageGeneration: null, imageGenerationModels: [],
    };
    const before = structuredClone({ providers, settings });
    const initial = useAppStore.getInitialState();
    const previous = { ...initial };
    try {
      Object.assign(initial, { providers, settings });
      const render = () => renderToStaticMarkup(createElement(
        I18nextProvider, { i18n }, createElement(ModelConfigPage),
      ));
      const html = render();
      assert.deepEqual(
        [...html.matchAll(/data-provider-id="([^"]+)"/g)].map((match) => match[1]),
        ["platform-first", "platform-second", "platform-paused", "platform-needs-key"],
      );
      assert.match(html, /class="model-default-model font-mono">platform-second-model<\/span>/);
      assert.match(html, /Choose a provider to view its token allowance/);
      assert.match(html, /class="model-default-model font-mono">gpt-image-2.5-flare<\/span>/);
      assert.match(html, /Video generation model/);
      assert.match(html, /MiniMax-H3/);
      assert.match(html, /No separate setup is needed/);
      assert.doesNotMatch(html, /legacy-openai|legacy-subscription|plugin-row|foreign-endpoint|unsupported-format/);
      assert.deepEqual({ providers, settings }, before, "rendering must not migrate or delete stored rows");

      // A legacy default remains persisted, but cannot masquerade as a usable
      // platform model or silently switch to the first available platform row.
      const legacyDefault = { ...settings, defaultProviderId: "legacy-openai", defaultModelId: "legacy-openai-model" };
      Object.assign(initial, { settings: legacyDefault });
      const legacyHtml = render();
      assert.doesNotMatch(legacyHtml, /class="model-default-model font-mono">/);
      assert.doesNotMatch(legacyHtml, /legacy-openai/);
      assert.deepEqual(initial.settings, legacyDefault);
      assert.equal(initial.providers, providers);
    } finally {
      Object.assign(initial, previous);
    }
  } finally {
    await server.close();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/*
 * A router or virtual model (OpenRouter auto, a pi-messages virtual model)
 * resolves to a concrete model per response (Pi 1.5 `responseModel`). The
 * turn's model chip shows what actually answered and keeps the requested model
 * reachable in its accessible label. Rendered through the real component and
 * English catalog.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function withMeta(run) {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { MessageMeta } = await server.ssrLoadModule("/src/features/chat/transcript/shared.tsx");
    const i18n = createInstance();
    // Match the app: React escapes rendered values (src/main.tsx).
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } }, interpolation: { escapeValue: false } });
    const render = (props) =>
      renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(MessageMeta, props)));
    await run({ render });
  } finally {
    await server.close();
  }
}

test("the model chip names the served model and labels the requested one", async () => {
  await withMeta(({ render }) => {
    const html = render({ modelId: "openrouter/auto", responseModelId: "anthropic/claude-sonnet-4.5" });
    assert.match(html, />anthropic\/claude-sonnet-4\.5</);
    assert.match(html, /aria-label="Requested openrouter\/auto; served by anthropic\/claude-sonnet-4\.5"/);
    assert.match(html, /title="Requested openrouter\/auto; served by anthropic\/claude-sonnet-4\.5"/);
  });
});

test("a turn without a different served model keeps the requested model chip", async () => {
  await withMeta(({ render }) => {
    const html = render({ modelId: "gpt-5.5" });
    assert.match(html, /title="gpt-5\.5">gpt-5\.5</);
    assert.doesNotMatch(html, /served by/);
  });
});

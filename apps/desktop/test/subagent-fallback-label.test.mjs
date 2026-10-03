import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { createServer } from "vite";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("fallback rows show provider names and disambiguate equal labels", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    resolve: { alias: { "@pi-desktop/shared": fileURLToPath(new URL("../../../packages/shared/src/index.ts", import.meta.url)) } },
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { SubagentFallbackModels } = await server.ssrLoadModule(
      "/src/components/settings/SubagentFallbackModels.tsx",
    );
    const i18n = createInstance();
    await i18n.init({ lng: "en", interpolation: { escapeValue: false }, resources: { en: { translation: {
      extensions: { subagents: {
        fallbackMoveUp: "Move {{model}} up",
        fallbackMoveDown: "Move {{model}} down",
        fallbackRemove: "Remove {{model}}",
      } },
    } } } });
    const render = (values, choices) => renderToStaticMarkup(
      createElement(I18nextProvider, { i18n }, createElement(SubagentFallbackModels, {
        primary: "",
        values,
        choices,
        onChange() {},
      })),
    );
    const pin = "721fcc76-026e-4f35-a32d-5e2a8d204499/deepseek-v4.1-flash";
    const choices = [{
      value: "other-provider/deepseek-v4.1-flash",
      modelId: "deepseek-v4.1-flash",
      providerId: "other-provider",
      providerName: "Other Workspace",
      vendorKey: "custom",
    }, {
      value: pin,
      modelId: "deepseek-v4.1-flash",
      providerId: "721fcc76-026e-4f35-a32d-5e2a8d204499",
      providerName: "DeepSeek Workspace",
      vendorKey: "custom",
    }];
    const html = render([pin], choices);
    assert.match(html, /DeepSeek Workspace\/deepseek-v4\.1-flash/);
    assert.match(html, /aria-label="Remove DeepSeek Workspace\/deepseek-v4\.1-flash"/);
    assert.doesNotMatch(html, /721fcc76-026e-4f35-a32d-5e2a8d204499/);
    assert.doesNotMatch(html, /1\. Other Workspace\/deepseek-v4\.1-flash/);

    const duplicateChoices = choices.map((choice) => ({ ...choice, providerName: "Shared Workspace" }));
    const duplicate = render([pin, choices[0].value], duplicateChoices);
    assert.match(duplicate, /Shared Workspace\/deepseek-v4\.1-flash \(721fcc76-026e-4f35-a32d-5e2a8d204499\)/);
    assert.match(duplicate, /Shared Workspace\/deepseek-v4\.1-flash \(other-provider\)/);
    assert.match(duplicate, /aria-label="Remove Shared Workspace\/deepseek-v4\.1-flash \(721fcc76-026e-4f35-a32d-5e2a8d204499\)"/);
    assert.match(duplicate, /aria-label="Remove Shared Workspace\/deepseek-v4\.1-flash \(other-provider\)"/);

    const legacy = render(["Shared Workspace/deepseek-v4.1-flash", pin], duplicateChoices);
    assert.match(legacy, /Shared Workspace\/deepseek-v4\.1-flash \(1: Shared Workspace\/deepseek-v4\.1-flash\)/);
    assert.match(legacy, /Shared Workspace\/deepseek-v4\.1-flash \(721fcc76-026e-4f35-a32d-5e2a8d204499\)/);

    const sameProviderChoices = [{ ...choices[1], value: "anthropic/deepseek-v4.1-flash", providerName: "Anthropic" }];
    const sameProvider = render(["anthropic/deepseek-v4.1-flash", "Anthropic/deepseek-v4.1-flash"], sameProviderChoices);
    assert.match(sameProvider, /Anthropic\/deepseek-v4\.1-flash \(1: anthropic\/deepseek-v4\.1-flash\)/);
    assert.match(sameProvider, /Anthropic\/deepseek-v4\.1-flash \(2: Anthropic\/deepseek-v4\.1-flash\)/);

    const unavailable = render([pin], []);
    assert.match(unavailable, /721fcc76-026e-4f35-a32d-5e2a8d204499\/deepseek-v4\.1-flash/);
  } finally {
    await server.close();
  }
});

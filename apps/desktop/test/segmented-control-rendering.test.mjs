import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("tab controls preserve panel links independently of translated labels", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { SegmentedControl } = await server.ssrLoadModule("/src/components/ui.tsx");
    for (const label of ["Import settings", "导入设置"]) {
      const html = renderToStaticMarkup(createElement(SegmentedControl, {
        value: "sessions", onChange() {}, label, role: "tablist",
        options: [
          { value: "sessions", label: "Sessions", id: "import-tab-sessions", controls: "import-panel-sessions" },
          { value: "models", label: "Models", id: "import-tab-models", controls: "import-panel-models" },
        ],
      }));
      assert.match(html, /id="import-tab-sessions"[^>]*aria-selected="true"[^>]*aria-controls="import-panel-sessions"/);
      assert.match(html, /id="import-tab-models"[^>]*aria-selected="false"[^>]*aria-controls="import-panel-models"/);
    }
  } finally {
    await server.close();
  }
});

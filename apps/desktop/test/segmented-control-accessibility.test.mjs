import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("segmented tabs retain panel relationships across selection and translated labels", async () => {
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
    for (const label of ["Import", "导入"]) {
      for (const value of ["sessions", "models"]) {
        const html = renderToStaticMarkup(createElement(SegmentedControl, {
          label, value, role: "tablist", onChange() {},
          options: ["sessions", "models"].map((id) => ({
            value: id, label: id, id: `import-tab-${id}`, controls: `import-panel-${id}`,
          })),
        }));
        for (const id of ["sessions", "models"]) {
          const button = html.match(new RegExp(`<button[^>]*id="import-tab-${id}"[^>]*>`))?.[0];
          assert.ok(button, `stable tab ID for ${id}`);
          assert.match(button, new RegExp(`aria-controls="import-panel-${id}"`));
          assert.match(button, new RegExp(`aria-selected="${value === id}"`));
        }
      }
    }
    for (const role of ["radiogroup", "group"]) {
      const html = renderToStaticMarkup(createElement(SegmentedControl, {
        label: "Sort", value: "recent", role, onChange() {},
        options: [{ value: "recent", label: "Recent" }],
      }));
      assert.match(html, role === "group" ? /aria-pressed="true"/ : /aria-checked="true"/);
      assert.doesNotMatch(html, /aria-controls|aria-selected/);
    }
  } finally {
    await server.close();
  }
});

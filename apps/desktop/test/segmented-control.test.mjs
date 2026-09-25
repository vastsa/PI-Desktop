import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("segmented controls preserve selection semantics and stable tab-panel links", async () => {
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
    const options = [
      { value: "ssh", label: "SSH", id: "host-ssh", controls: "panel-ssh" },
      { value: "pair", label: "Pair", id: "host-pair", controls: "panel-pair" },
    ];
    let value = "ssh";
    const render = (props = {}) => SegmentedControl({
      value, options, label: "Add host", role: "tablist",
      onChange: (next) => { value = next; }, ...props,
    });
    for (const label of ["Add host", "添加主机"]) {
      const html = renderToStaticMarkup(render({ label }));
      assert.match(html, /role="tab" id="host-ssh" aria-controls="panel-ssh" aria-selected="true"/);
      assert.match(html, /role="tab" id="host-pair" aria-controls="panel-pair" aria-selected="false"/);
    }
    render().props.children.find((tab) => tab.props.id === "host-pair").props.onClick();
    assert.equal(value, "pair");
    const selected = renderToStaticMarkup(render());
    assert.match(selected, /id="host-pair" aria-controls="panel-pair" aria-selected="true"/);
    assert.match(selected, /id="host-ssh" aria-controls="panel-ssh" aria-selected="false"/);
    assert.match(renderToStaticMarkup(render({ role: undefined })), /role="radio" aria-checked="true"/);
    assert.match(renderToStaticMarkup(render({ role: "group" })), /aria-pressed="true"/);
    assert.equal((renderToStaticMarkup(render({ disabled: true })).match(/disabled=""/g) ?? []).length, 2);
  } finally {
    await server.close();
  }
});

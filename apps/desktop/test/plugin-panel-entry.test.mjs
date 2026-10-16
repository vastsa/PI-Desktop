import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * Issue #998: the extensions page named a plugin's panel without offering any
 * way to open it from the row. These tests pin the two entries the row now
 * has -- the action keeps its label next to the icon, and the `panel`
 * capability chip itself opens the window -- and that a plugin without a
 * panel gets neither.
 */

const PANEL_PLUGIN = {
  id: "cn.star.demo",
  name: "Demo",
  version: "1.0.0",
  enabled: true,
  capabilities: ["panel", "tools"],
  permissions: ["ui.panel"],
};

async function chips(t, props) {
  const { load, render } = await slotSsr(t);
  const { CapabilityChips } = await load("/src/features/plugins/presentation.tsx");
  return render(createElement(CapabilityChips, props), { sessionId: null });
}

test("a panel capability renders as the control that opens it", async (t) => {
  const markup = await chips(t, {
    capabilities: PANEL_PLUGIN.capabilities,
    onOpenPanel: () => {},
  });

  const buttons = markup.match(/<button/g) ?? [];
  assert.equal(buttons.length, 1, "only the panel capability is actionable");
  assert.match(markup, /<button[^>]*class="plugins-cap-chip is-action"/);
  assert.match(markup, /<button[^>]*title="Open panel"/);
  assert.match(markup, />Panel</);
  // Every other capability stays a label: only the panel has a window.
  assert.match(markup, /<span class="plugins-cap-chip">Agent tools<\/span>/);
});

test("a capability without a window behind it stays a label", async (t) => {
  const markup = await chips(t, { capabilities: PANEL_PLUGIN.capabilities });

  assert.doesNotMatch(markup, /<button/);
  assert.match(markup, /<span class="plugins-cap-chip">Panel<\/span>/);
});

test("an empty contribution list renders nothing at all", async (t) => {
  const markup = await chips(t, { capabilities: [], onOpenPanel: () => {} });
  assert.equal(markup, "");
});

test("the installed row labels its panel action and wires it to the panel", async () => {
  const source = await readFile(
    new URL("../src/features/plugins/InstalledPluginsPanel.tsx", import.meta.url),
    "utf8",
  );
  // Icon plus label, not an icon the user has to hover to identify.
  assert.match(source, /className="plugins-panel-btn"/);
  assert.match(source, /<IconPanel size=\{15\} \/>\s*<span>\{t\("plugins\.openPanel"\)\}<\/span>/);
  // The same row hands the panel opener to its capability readout.
  assert.match(source, /onOpenPanel=\{/);
  assert.match(source, /api\.openPluginPanel\(plugin\.id\)/);
});

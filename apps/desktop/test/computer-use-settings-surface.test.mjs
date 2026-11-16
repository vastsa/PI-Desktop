import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("agent behavior places computer use after the session defaults and execution", async () => {
  // The destination is Behavior since D684; computer use stays its last card,
  // after what a run starts with and what it may do.
  const source = await readFile(
    new URL("../src/features/settings/pages/AgentBehaviorSettings.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    source.indexOf('t("settings.sessionDefaults")') < source.indexOf('t("settings.execution")'),
  );
  assert.ok(
    source.indexOf('t("settings.execution")') < source.indexOf("<ComputerUseSettings"),
  );
  assert.match(source, /<ComputerUseSettings[^>]+\/>\s*<\/div>/);
});

test("computer use keeps controls and required status without explanatory copy", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ComputerUseSettings } = await server.ssrLoadModule(
    "/src/features/settings/computer-use/ComputerUseSettings.tsx",
  );
  for (const enabled of [false, true]) {
    const html = renderToStaticMarkup(React.createElement(ComputerUseSettings, {
      t: (key) => key, settings: { computerUse: { enabled } },
      saveSettings: async () => { throw new Error("Rendering must not save settings"); },
    }));
    for (const key of ["title", "enable", "platform", "platformUnknown"]) {
      assert.ok(html.includes(`computerUse.${key}`), `missing ${key}`);
    }
    for (const key of ["description", "enableDesc", "scopeNote", "modelDesc", "captureDesc"]) {
      assert.ok(!html.includes(`computerUse.${key}`), `explanatory copy remains: ${key}`);
    }
    assert.equal(html.includes("computerUse.modelMissing"), enabled);
    assert.equal(html.includes("computerUse.captureA11yOnly"), enabled);
    assert.match(html, /role="switch"/);
    assert.equal(html.includes('aria-checked="true"'), enabled);
  }
});

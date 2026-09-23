import assert from "node:assert/strict";
import test from "node:test";
import { readMainModule, readMainSource } from "./helpers/source-contracts.mjs";

test("plugin schemes are reserved together, in the only privileged registration", async () => {
  // Electron honours a single registerSchemesAsPrivileged call. A second call
  // replaces the scheme lists the renderer inherits, so whichever plugin
  // scheme registered first would silently lose fetch/CORS in the window.
  const mainSource = await readMainSource();
  assert.equal(mainSource.match(/registerSchemesAsPrivileged\(/g)?.length, 1);
  const schemes = await readMainModule("plugin-schemes.ts");
  assert.match(
    schemes,
    /registerSchemesAsPrivileged\(\[\s*PLUGIN_ASSET_SCHEME_PRIVILEGES,\s*PLUGIN_RENDERER_SCHEME_PRIVILEGES,\s*\]\)/,
  );
  const startup = await readMainModule("bootstrap/startup.ts");
  assert.ok(
    startup.indexOf("registerPluginSchemes();") < startup.indexOf("app.whenReady()"),
    "schemes are reserved before the app is ready",
  );
});

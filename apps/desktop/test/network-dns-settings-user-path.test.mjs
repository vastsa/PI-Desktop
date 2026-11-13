import assert from "node:assert/strict";
import test from "node:test";
import { runIsolatedRenderer } from "./helpers/isolated-renderer.mjs";

test("Network settings save, restore and validate native DoH through the renderer API", {
  timeout: 90_000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const result = await runIsolatedRenderer("apps/desktop/test/e2e/network-dns/fixture.tsx", "networkDnsProbe", { focusDocument: true });
  for (const [behavior, passed] of Object.entries(result)) assert.equal(passed, true, behavior);
  assert.equal(Object.keys(result).length, 9);
});

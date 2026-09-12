import assert from "node:assert/strict";
import test from "node:test";
import { validateCatalog } from "../../../scripts/check-marketplace-catalog.mjs";

const packageFields = {
  version: "1.0.0",
  shasum: "a".repeat(64),
  url: "https://raw.githubusercontent.com/vastsa/pi-desktop-plugins/main/packages/demo.hello-1.0.0.piplug",
  sizeBytes: 1024,
  permissions: ["ui.panel"],
};

function catalog(plugin) {
  return {
    schemaVersion: 1,
    providerId: "official",
    plugins: [plugin],
  };
}

test("preflight accepts a string catalog author", () => {
  const errors = validateCatalog(
    catalog({
      id: "demo.hello",
      author: "PI-Desktop",
      versions: [packageFields],
    }),
    "demo.hello",
    "https://raw.githubusercontent.com/vastsa/pi-desktop-plugins/main/catalog.json",
  );
  assert.deepEqual(errors, []);
});

test("preflight rejects a plugin-manifest author object in the catalog", () => {
  const errors = validateCatalog(
    catalog({
      id: "com.vastsa.voice-assistant",
      author: { name: "VastSa", url: "https://github.com/vastsa" },
      versions: [packageFields],
    }),
    "com.vastsa.voice-assistant",
    "https://raw.githubusercontent.com/vastsa/pi-desktop-plugins/main/catalog.json",
  );
  assert.ok(
    errors.some((error) =>
      error.includes("author must be a string (not a {name,url} object)"),
    ),
    errors.join("\n"),
  );
});

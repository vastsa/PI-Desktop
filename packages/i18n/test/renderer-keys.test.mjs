/**
 * Every literal `t("…")` key in the renderer must exist in every shipped catalog.
 *
 * `catalogs.test.mjs` only compares locales against English, so a key that a
 * component uses but no locale defines passes there and then renders as the
 * raw key string in the UI. That is exactly how `settings.serviceModels` and
 * friends shipped untranslated, so this test closes the loop from the call
 * sites back to the catalogs.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { catalogs, flattenCatalog } from "../src/index.ts";

const SRC = new URL("../../../apps/desktop/src/", import.meta.url);

/** Every .ts/.tsx file under the renderer source tree. */
async function sources(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(path)));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/**
 * i18next resolves a bare key against its plural forms when a count is passed,
 * so `key_one` / `key_other` satisfy a lookup for `key`.
 */
function has(catalog, key) {
  return key in catalog || `${key}_one` in catalog || `${key}_other` in catalog;
}

const files = await sources(new URL(".", SRC).pathname);
const used = new Map();
for (const file of files) {
  const text = await readFile(file, "utf8");
  // Only dotted literals: dynamic keys such as t(`thinkingLevel.${level}`)
  // cannot be resolved statically and are covered by catalogs.test.mjs.
  for (const match of text.matchAll(/\bt\(\s*"([a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)"/g)) {
    if (!used.has(match[1])) used.set(match[1], file);
  }
}

const flats = Object.fromEntries(
  Object.entries(catalogs).map(([id, catalog]) => [id, flattenCatalog(catalog)]),
);

test("the renderer uses a non-trivial number of catalog keys", () => {
  // Guards against the scan silently matching nothing after a refactor.
  assert.ok(used.size > 500, `only found ${used.size} keys — is the scan still correct?`);
});

for (const [id, catalog] of Object.entries(flats)) {
  test(`every key the renderer asks for exists in ${id}`, () => {
    const missing = [...used].filter(([key]) => !has(catalog, key));
    assert.deepEqual(
      missing.map(([key, file]) => `${key} (${file.replace(/.*\/apps\//, "apps/")})`),
      [],
    );
  });
}

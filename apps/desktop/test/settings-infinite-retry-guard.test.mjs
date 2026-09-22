import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const apiSource = await readFile(
  new URL("../src/lib/api.ts", import.meta.url),
  "utf8",
);
const mainSource = await readFile(
  new URL("../electron/main/runtime/provider-catalog.ts", import.meta.url),
  "utf8",
);

// The regression: an install that never stored `infiniteProviderRetry` used to
// get the key written back as `undefined`, and the write validator — which
// gated on `hasOwnProperty` — then rejected it as "not a boolean". Every
// settings save threw, so the queued prompt animation picker (and every other
// row) silently did nothing.
for (const [label, source] of [
  ["renderer", apiSource],
  ["main", mainSource],
]) {
  test(`${label} normalize omits an unset infiniteProviderRetry key`, () => {
    const normalize = source.slice(
      source.indexOf("export function normalizeSettings") >= 0
        ? source.indexOf("export function normalizeSettings")
        : source.indexOf("const normalizeSettings"),
      source.indexOf("const validateSettingsWrite") >= 0
        ? source.indexOf("const validateSettingsWrite")
        : source.indexOf("const listRuntimeProviders"),
    );
    assert.doesNotMatch(normalize, /^\s*infiniteProviderRetry:/m);
    assert.match(normalize, /infiniteProviderRetry: true/);
    assert.match(normalize, /: \{\}\)/);
  });

  test(`${label} write validation treats undefined as not stored`, () => {
    const start =
      source.indexOf("const validateSettingsWrite") >= 0
        ? source.indexOf("const validateSettingsWrite")
        : source.indexOf("export function validateSettingsWrite");
    const end =
      source.indexOf("const listRuntimeProviders") >= 0
        ? source.indexOf("const listRuntimeProviders")
        : source.length;
    const validate = source.slice(start, end);
    assert.match(
      validate,
      /value\.infiniteProviderRetry !== undefined &&\s*\n\s*typeof value\.infiniteProviderRetry !== "boolean"/,
    );
    assert.doesNotMatch(
      validate,
      /hasOwnProperty\.call\(value, "infiniteProviderRetry"\)/,
    );
    // A real non-boolean is still rejected.
    assert.match(validate, /infiniteProviderRetry is invalid/);
    // The other fields keep their own guards untouched.
    assert.match(
      validate,
      /hasOwnProperty\.call\(value, "defaultCommandShell"\)/,
    );
  });
}

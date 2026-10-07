import assert from "node:assert/strict";
import test from "node:test";
import {
  isModelsDevProviderCatalog,
  resolveReleaseDocumentCheck,
} from "./release-version-check.mjs";

test("checks a stable release against one aligned version", () => {
  assert.deepEqual(resolveReleaseDocumentCheck("0.15.2", "0.15.2"), {
    documentVersion: "0.15.2",
    surfaceVersion: "0.15.2",
    isPrereleasePreview: false,
  });
});

test("checks a prerelease preview against its stable documentation version", () => {
  assert.deepEqual(resolveReleaseDocumentCheck("0.15.2-beta.2", "0.15.2"), {
    documentVersion: "0.15.2",
    surfaceVersion: "0.15.2-beta.2",
    isPrereleasePreview: true,
  });
});

test("does not hide a mismatched requested version", () => {
  assert.deepEqual(resolveReleaseDocumentCheck("0.15.2-beta.2", "0.15.1"), {
    documentVersion: "0.15.1",
    surfaceVersion: "0.15.1",
    isPrereleasePreview: false,
  });
});

test("accepts a models.dev provider catalog with model records", () => {
  assert.equal(isModelsDevProviderCatalog({ provider: { models: { model: {} } } }), true);
});

test("rejects invalid or empty models.dev catalogs", () => {
  for (const value of [null, [], {}, { provider: {} }, { provider: null }]) {
    assert.equal(isModelsDevProviderCatalog(value), false);
  }
});

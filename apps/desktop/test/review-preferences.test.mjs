import assert from "node:assert/strict";
import test from "node:test";
import {
  readReviewContextLines,
  rememberReviewContextLines,
  REVIEW_CONTEXT_STORAGE_KEY,
} from "../src/lib/review-preferences.ts";

function storageFixture(t, store) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => store });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  });
}

test("missing or invalid context preferences use three lines without writing", t => {
  let value = null;
  storageFixture(t, {
    getItem: key => { assert.equal(key, REVIEW_CONTEXT_STORAGE_KEY); return value; },
    setItem: () => assert.fail("Reading preferences must not write"),
  });
  for (value of [null, "", "0", "2", "20", "-1", "null", "{}", "true", "1.0", " 1 ", '"5"']) {
    assert.equal(readReviewContextLines(), 3, String(value));
  }
});

test("all supported context values round-trip through one profile-wide key", t => {
  const values = new Map();
  storageFixture(t, {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  });
  for (const lines of [1, 3, 5]) {
    rememberReviewContextLines(lines);
    assert.equal(readReviewContextLines(), lines);
    assert.deepEqual([...values], [[REVIEW_CONTEXT_STORAGE_KEY, String(lines)]]);
  }
});

test("unavailable storage preserves the default and never blocks a choice", t => {
  storageFixture(t, undefined);
  assert.equal(readReviewContextLines(), 3);
  assert.doesNotThrow(() => rememberReviewContextLines(1));
});

test("storage access, read and quota failures do not escape to review UI", t => {
  storageFixture(t, {
    getItem: () => { throw new Error("Storage blocked"); },
    setItem: () => { throw new Error("Quota exceeded"); },
  });
  assert.equal(readReviewContextLines(), 3);
  assert.doesNotThrow(() => rememberReviewContextLines(5));
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("Access denied"); } });
  assert.equal(readReviewContextLines(), 3);
  assert.doesNotThrow(() => rememberReviewContextLines(1));
});

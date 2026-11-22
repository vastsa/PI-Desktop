import { register } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { detectTextDirection, directionAttr, countStrongCharacters } = await import(
  "../src/lib/text-direction.ts"
);

test("counts all Persian letters, including the review regressions", () => {
  assert.deepEqual(countStrongCharacters("پچژگ"), { ltr: 0, rtl: 4 });
  assert.deepEqual(countStrongCharacters("پژگچ"), { ltr: 0, rtl: 4 });
  assert.equal(directionAttr("hello چپ چپ چپ چپ چپ"), "rtl");
  const alphabet = "اآبپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی";
  assert.deepEqual(countStrongCharacters(alphabet), { ltr: 0, rtl: [...alphabet].length });
});

test("digits, punctuation, combining marks and bidi controls do not vote", () => {
  for (const text of ["... ؟ ؛", "123٤٥۶۷۸۹", "\u0301\u0651\u0652", "\u200c\u200d\u202a\u202b\u2066\u2067"]) {
    assert.deepEqual(countStrongCharacters(text), { ltr: 0, rtl: 0 });
    assert.equal(directionAttr(text), undefined);
  }
  assert.deepEqual(countStrongCharacters("hello 123 ۱۲۳ ؟ ؛ \u0651"), { ltr: 5, rtl: 0 });
  assert.equal(directionAttr("hello 123 ۱۲۳ ؟ ؛ \u0651"), "ltr");
  assert.deepEqual(countStrongCharacters("e\u0301 پ\u0651"), { ltr: 1, rtl: 1 });
  assert.deepEqual(countStrongCharacters("\u02b9\u02ba\u02c6\u02cf\u02ec\u0374\u2e2f\ua67f\ua717\ua71f\ua788"), { ltr: 0, rtl: 0 });
});

test("RTL letters include presentation forms and supplementary historic scripts", () => {
  for (const text of ["שלום", "ܐܒ", "ހށ", "ߊߋ", "𞤀𞤁", "𐤀𐤁", "𐴀𐴁", "ﭖﭺ", "𞸀"]) {
    assert.deepEqual(countStrongCharacters(text), { ltr: 0, rtl: [...text].length });
    assert.equal(directionAttr(text), "rtl");
  }
});

test("majority letters, not the opening word or numbers, set direction", () => {
  for (const text of ["hello این جمله فارسی است و باید راست‌به‌چپ باشد", "این یک تست است با کلمه React و next.js در وسط جمله.", "rtl یه متن بنویس فارسی قاطی میشه یا نه رندوم ببینم"]) {
    assert.equal(detectTextDirection(text), "rtl");
  }
  for (const text of ["fix the bug بعدا", "plain english only", "hello ۱۲۳۴۵۶۷۸۹۰ ؟ ؛"]) {
    assert.equal(detectTextDirection(text), "ltr");
  }
  assert.equal(detectTextDirection("aپ"), "ltr");
  assert.equal(detectTextDirection(""), "auto");
});

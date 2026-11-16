import { register } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { detectTextDirection, directionAttr, countStrongCharacters } = await import(
  "../src/lib/text-direction.ts"
);

const PERSIAN_FIRST = "این یک تست است با کلمه React و next.js در وسط جمله.";
const ENGLISH_FIRST = "rtl یه متن بنویس فارسی قاطی میشه یا نه رندوم ببینم";
const ENGLISH_OPEN_PERSIAN_BODY = "hello این جمله فارسی است و باید راست‌به‌چپ باشد";

test("counts strong LTR and RTL characters", () => {
  const counts = countStrongCharacters("React و next.js");
  assert.equal(counts.ltr, "Reactnextjs".length);
  assert.equal(counts.rtl, 1);
  assert.deepEqual(countStrongCharacters("1234 ... ()"), { ltr: 0, rtl: 0 });
});

test("RTL-dominant paragraphs are rtl even when they open with English", () => {
  // The first-strong rule would call this ltr; the majority script is Persian.
  assert.equal(detectTextDirection(ENGLISH_OPEN_PERSIAN_BODY), "rtl");
  assert.equal(detectTextDirection(PERSIAN_FIRST), "rtl");
  assert.equal(detectTextDirection(ENGLISH_FIRST), "rtl");
});

test("LTR-dominant paragraphs are ltr even when they end with Persian", () => {
  assert.equal(detectTextDirection("fix the bug بعدا"), "ltr");
  assert.equal(detectTextDirection("plain english only"), "ltr");
});

test("paragraphs without strong characters stay auto", () => {
  // Arabic-Indic digits are weak (AN), punctuation neutral — no strong runs.
  assert.equal(detectTextDirection("۱۲۳۴ ... !"), "auto");
  assert.equal(detectTextDirection(""), "auto");
});

test("directionAttr omits dir for neutral text and emits rtl/ltr otherwise", () => {
  assert.equal(directionAttr("۱۲۳۴ ... !"), undefined);
  assert.equal(directionAttr(PERSIAN_FIRST), "rtl");
  assert.equal(directionAttr("plain english"), "ltr");
});

test("markdown paragraph and list renderers carry the content-aware dir", async () => {
  const markdownSource = await readFile(
    new URL("../src/components/Markdown.tsx", import.meta.url),
    "utf8",
  );
  assert.match(markdownSource, /p: BidiParagraph/);
  assert.match(markdownSource, /li: BidiListItem/);
  assert.match(markdownSource, /dir=\{directionAttr\(textOfChildren\(children\)\)\}/);
  assert.match(markdownSource, /from "\.\.\/lib\/text-direction"/);
});

test("user message bubbles and inline runs are direction-aware", async () => {
  const rowSource = await readFile(
    new URL("../src/features/chat/transcript/MessageRow.tsx", import.meta.url),
    "utf8",
  );
  assert.match(rowSource, /dir=\{userTextDirection\}/);
  assert.match(rowSource, /directionAttr\(directories\.text\)/);
});

test("styles isolate inline runs and give the composer per-paragraph auto direction", async () => {
  const styles = await readFile(
    new URL("../src/styles/messages.css", import.meta.url),
    "utf8",
  );
  const isolate = styles.match(
    /\.message-user-text \.chat-command-chip[\s\S]*?unicode-bidi: isolate;/,
  )?.[0] ?? "";
  assert.match(isolate, /\.prose-chat a/);
  assert.match(isolate, /\.prose-chat code/);
  const editor = styles.match(/\.composer-input,\n\.message-edit-input \{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(editor, /unicode-bidi: plaintext;/);
});

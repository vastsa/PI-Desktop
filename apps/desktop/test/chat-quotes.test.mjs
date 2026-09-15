import { readStoreSource, readTranscriptSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MAX_QUOTE_CHARS,
  appendQuoteToDraft,
  buildQuoteText,
  quoteExcerpt,
} from "../src/lib/chat-quotes.ts";

const transcript = await readTranscriptSource();
const store = await readStoreSource();

test("a quote carries the selected text when there is a selection", () => {
  assert.equal(
    quoteExcerpt("the whole answer", "only this part"),
    "only this part",
  );
  assert.equal(quoteExcerpt("the whole answer", "   "), "the whole answer");
  assert.equal(quoteExcerpt("the whole answer"), "the whole answer");
});

test("a quote normalizes line endings and trims the excerpt", () => {
  assert.equal(quoteExcerpt("  first\r\nsecond  \r\n"), "first\nsecond");
});

test("a long excerpt is cut once and marked with an ellipsis", () => {
  const excerpt = quoteExcerpt("x".repeat(MAX_QUOTE_CHARS + 500));
  assert.equal(excerpt.length, MAX_QUOTE_CHARS + 1);
  assert.ok(excerpt.endsWith("…"));
});

test("a cut never splits a surrogate pair", () => {
  // The bound lands between the two halves of the astral character, so the
  // excerpt must drop the lone high surrogate instead of emitting it.
  const excerpt = quoteExcerpt(`${"a".repeat(MAX_QUOTE_CHARS - 1)}😀tail`);
  assert.equal(excerpt.length, MAX_QUOTE_CHARS);
  assert.doesNotMatch(excerpt, /[\uD800-\uDBFF]$/);
});

test("quote text is a blockquote plus its attribution", () => {
  assert.equal(
    buildQuoteText("one\ntwo", "Quoted from Fix the parser"),
    "> one\n> two\n\nQuoted from Fix the parser",
  );
  assert.equal(
    buildQuoteText("one\n\ntwo", "Quoted from Fix the parser"),
    "> one\n>\n> two\n\nQuoted from Fix the parser",
  );
});

test("quoting appends to a draft instead of replacing it", () => {
  assert.equal(appendQuoteToDraft("", "> quoted"), "> quoted");
  assert.equal(appendQuoteToDraft("do this:  ", "> quoted"), "do this:\n\n> quoted");
});

test("the quote action is wired to the composer draft and never sends", () => {
  assert.match(transcript, /quoteMessageIntoComposer\(\{/);
  assert.match(transcript, /selectionMarkdownWithinRow\(message\.id\)/);
  assert.match(transcript, /selectionMarkdownWithinRow\(entry\.anchorId\)/);
  assert.match(transcript, /t\("chat\.quote"\)/);
  // Quoting only edits a draft: no prompt, session, or transcript write.
  assert.match(store, /quoteMessageIntoComposer: \(\{ title, text, selection \}\)/);
  assert.match(store, /buildQuoteText\(\s*excerpt,/);
  assert.match(store, /i18n\.t\("chat\.quoteSource", \{ title \}\)/);
  assert.match(store, /appendComposerDraftText: \(text\) => \{/);
  assert.match(store, /appendQuoteToDraft\(draft\?\.text \?\? "", text\)/);
});

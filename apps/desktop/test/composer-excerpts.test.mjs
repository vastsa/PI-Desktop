import assert from "node:assert/strict";
import test from "node:test";
import { serializeComposerExcerpts } from "../src/lib/composer-excerpts.ts";
import {
  appendComposerDraftExcerpt,
  captureComposerDraft,
  readComposerDraft,
  resetComposerDraftCache,
} from "../src/lib/composer-draft-cache.ts";

test.afterEach(resetComposerDraftCache);

test("selected text attaches to only its own in-memory draft", () => {
  captureComposerDraft("session-a", "Keep this", [], "/project");
  const first = appendComposerDraftExcerpt("session-a", " first\nsecond ");
  const second = appendComposerDraftExcerpt("session-a", "another");
  assert.equal(readComposerDraft("session-a")?.text, "Keep this");
  assert.deepEqual(readComposerDraft("session-a")?.excerpts, [
    { id: first?.id, text: "first\nsecond" },
    { id: second?.id, text: "another" },
  ]);
  assert.equal(readComposerDraft("session-a")?.workspacePath, "/project");
  assert.equal(readComposerDraft("session-b"), undefined);
  assert.equal(appendComposerDraftExcerpt("session-a", " \n "), null);
});

test("send serialization keeps editable text ahead of the quoted selections", () => {
  const excerpts = [
    { id: "a", text: "first\n\nlast" },
    { id: "b", text: "another" },
  ];
  assert.equal(
    serializeComposerExcerpts("Please explain", excerpts),
    "Please explain\n\nSelected conversation excerpts:\n1.\n> first\n>\n> last\n\n2.\n> another",
  );
  assert.equal(serializeComposerExcerpts("", [excerpts[0]]),
    "Selected conversation excerpt:\n> first\n>\n> last");
  assert.equal(serializeComposerExcerpts("plain", []), "plain");
});

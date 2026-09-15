import { readStoreModule, readTranscriptSource } from "./helpers/source-contracts.mjs";
/**
 * The comment editor's flow (ADR response-annotations / D-LOCAL-response-annotations), driven through the same pure
 * transitions the store calls: opening from an excerpt, saving the comment into
 * the annotation, re-editing an already attached excerpt, and dropping a save
 * whose annotation was already sent or removed.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  annotationEditorFor,
  applyAnnotationComment,
  responseAnnotationPrompt,
} from "../src/lib/response-annotations.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const store = await readStoreModule("slices/annotation-slice.ts");
const composer = await read("../src/components/ResponseAnnotationOverlay.tsx");
const overlay = await read("../src/components/SelectionQuoteButton.tsx");
const transcript = await readTranscriptSource();
const dialog = await read("../src/components/ResponseAnnotationDialog.tsx");

test("Add to chat opens the comment editor instead of attaching the excerpt", () => {
  assert.deepEqual(
    annotationEditorFor([], {
      sessionId: "s1",
      messageId: "m1",
      text: "  a quoted pass  ",
    }),
    {
      sessionId: "s1",
      messageId: "m1",
      text: "a quoted pass",
      annotationId: null,
      comment: "",
    },
  );
  // A blank excerpt has nothing to quote and opens nothing.
  assert.equal(
    annotationEditorFor([], { sessionId: "s1", messageId: "m1", text: "  " }),
    null,
  );
});

test("saving attaches the excerpt with its comment in attachment order", () => {
  const first = annotationEditorFor([], {
    sessionId: "s1",
    messageId: "m1",
    text: "first pass",
  });
  const one = applyAnnotationComment([], first, "  explain this  ", "a1", 5);
  assert.deepEqual(one, [
    {
      id: "a1",
      messageId: "m1",
      text: "first pass",
      annotation: "explain this",
      createdAt: 5,
    },
  ]);
  // A save with an empty comment still attaches: Add to chat works without one.
  const second = annotationEditorFor(one, {
    sessionId: "s1",
    messageId: "m2",
    text: "second pass",
  });
  const two = applyAnnotationComment(one, second, "", "a2", 9);
  assert.deepEqual(
    two.map((annotation) => [annotation.id, annotation.annotation]),
    [
      ["a1", "explain this"],
      ["a2", ""],
    ],
  );
});

test("an already attached excerpt reopens for editing and is never doubled", () => {
  const existing = [
    {
      id: "a1",
      messageId: "m1",
      text: "the pass",
      annotation: "old",
      createdAt: 1,
    },
  ];
  const reopened = annotationEditorFor(existing, {
    sessionId: "s1",
    messageId: "m1",
    text: "the pass",
  });
  assert.deepEqual(reopened, {
    sessionId: "s1",
    messageId: "m1",
    text: "the pass",
    annotationId: "a1",
    comment: "old",
  });
  const updated = applyAnnotationComment(existing, reopened, "new", "a2", 9);
  assert.deepEqual(updated, [
    {
      id: "a1",
      messageId: "m1",
      text: "the pass",
      annotation: "new",
      createdAt: 1,
    },
  ]);
  // Re-saving the same comment changes nothing, and a duplicate attachment of
  // the same excerpt is refused.
  assert.equal(applyAnnotationComment(existing, reopened, "old", "a3", 9), null);
  assert.equal(
    applyAnnotationComment(
      existing,
      {
        sessionId: "s1",
        messageId: "m1",
        text: "the pass",
        annotationId: null,
        comment: "",
      },
      "again",
      "a4",
      9,
    ),
    null,
  );
});

test("a saved and edited comment reaches the model as structured data", () => {
  const editor = annotationEditorFor([], {
    sessionId: "s1", messageId: "m1", text: "$x^2$",
  });
  const saved = applyAnnotationComment([], editor, "initial", "a1", 1);
  const reopened = annotationEditorFor(saved, {
    sessionId: "s1", messageId: "m1", text: "$x^2$", annotationId: "a1",
  });
  const updated = applyAnnotationComment(saved, reopened, '解释 "x"\n再举例', "a2", 2);
  const prompt = responseAnnotationPrompt("please review", updated);
  const payload = JSON.parse(prompt.split("<response-annotations>\n")[1].split("\n</response-annotations>")[0]);
  assert.deepEqual(payload, [{
    text: "$x^2$", annotation: '解释 "x"\n再举例', source: { messageId: "m1" },
  }]);
  assert.ok(prompt.endsWith("## My request:\nplease review"));
});

test("a stale editor never restores a sent or removed annotation", () => {
  // The explicit edit target no longer exists: no editor opens for it, and no
  // save recreates it.
  assert.equal(
    annotationEditorFor([], {
      sessionId: "s1",
      messageId: "m1",
      text: "gone",
      annotationId: "a1",
    }),
    null,
  );
  assert.equal(
    applyAnnotationComment(
      [],
      {
        sessionId: "s1",
        messageId: "m1",
        text: "gone",
        annotationId: "a1",
        comment: "",
      },
      "resurrect me",
      "a9",
      1,
    ),
    null,
  );
});

test("the editor belongs to the session it was opened in", () => {
  const editor = annotationEditorFor([], {
    sessionId: "s1",
    messageId: "m1",
    text: "the pass",
  });
  assert.equal(editor.sessionId, "s1");
  // A session switch must not keep editing another session's annotations.
  assert.match(dialog, /editor\.sessionId === activeSessionId/);
  assert.match(dialog, /editor\.sessionId !== activeSessionId/);
});

test("the quote surfaces open the editor and never attach directly", () => {
  assert.match(
    overlay,
    /openResponseAnnotationEditor\(\{\s*messageId: target\.rowAnchorId,\s*text: target\.markdown,\s*anchor: selectionAnnotationAnchorWithinRow\(target\.rowAnchorId\),\s*\}\)/,
  );
  assert.match(
    transcript,
    /openResponseAnnotationEditor\(\{\s*messageId: entry\.anchorId,\s*text: selection \|\| content,\s*anchor: selectionAnnotationAnchorWithinRow\(entry\.anchorId\),\s*\}\)/,
  );
  assert.doesNotMatch(overlay, /addResponseAnnotation/);
  assert.doesNotMatch(transcript, /addResponseAnnotation/);
});

test("the store saves the editor through the annotation transition", () => {
  assert.match(store, /responseAnnotationEditor: annotationEditorFor\(current, \{/);
  assert.match(
    store,
    /const next = applyAnnotationComment\(\s*current,\s*editor,\s*comment,\s*crypto\.randomUUID\(\),\s*\);/,
  );
  // A no-op save closes the editor without resurrecting the annotation.
  assert.match(store, /if \(!next\) return \{ responseAnnotationEditor: null \};/);
  assert.match(store, /\[editor\.sessionId\]: next/);
});

test("the floating index lists each annotation with edit and remove actions", () => {
  assert.match(composer, /data-testid="composer-annotation-menu"/);
  assert.match(composer, /data-testid="composer-annotation-item"/);
  assert.match(
    composer,
    /edit\(\{\s*messageId: annotation\.messageId,\s*text: annotation\.text,\s*annotationId: annotation\.id\s*\}\)/,
  );
  assert.match(composer, /remove\(annotation\.id\)/);
  assert.match(composer, /aria-expanded=\{expanded\}/);
  assert.ok(composer.includes('ariaLabel={`${t("chat.annotationEdit")} ${index + 1}`}'));
  assert.ok(composer.includes('ariaLabel={`${t("chat.annotationRemove")} ${index + 1}`}'));
});

test("the comment editor is accessible, saves on submit, and never sends", () => {
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /event\.key === "Escape"/);
  assert.match(dialog, /input\.focus\(\)/);
  assert.match(dialog, /t\("chat\.annotationCommentPlaceholder"\)/);
  assert.match(dialog, /onSave\(comment\)/);
  assert.doesNotMatch(dialog, /sendPrompt|api\.prompt/);
});

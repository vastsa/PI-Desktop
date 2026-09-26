/**
 * An `@agent` mention is one thing in the draft, the way a file reference is.
 *
 * The chip machinery is what makes that true: a sentinel character stands in
 * for the mention in the draft string, and the editor paints it as a
 * `contentEditable=false` element. Atomic deletion is that property doing its
 * job — the caret cannot land inside a chip, so Backspace removes the whole
 * mention rather than eating `@explo` and leaving `rer` behind.
 *
 * The other half is that a delegate must stay a delegate everywhere else. Its
 * `path` is a `Task` handle, not a location, so any code that maps references
 * onto attachments has to drop it; these tests pin the boundaries where that
 * could otherwise leak.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { serializeInlineComposerFileReferences } from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  createAgentReference,
  createFileReference,
  isAgentReference,
  isChipTokenChar,
  isEditableTextReference,
  nextChipToken,
  restoreComposerReference,
} = await import("../src/features/chat/composer/editor.ts");
const { optimisticUserMessage } = await import("../src/lib/session-transcript.ts");

const editorSource = await readFile(
  new URL("../src/features/chat/composer/editor.ts", import.meta.url),
  "utf8",
);
const composerSource = await readFile(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);
const storeSource = await readFile(
  new URL("../src/stores/app-store.ts", import.meta.url),
  "utf8",
);
const draftHookSource = await readFile(
  new URL("../src/features/chat/composer/hooks/useComposerDraft.ts", import.meta.url),
  "utf8",
);

const TOKEN = "";

test("an agent mention is an agent, and names the handle it delegates to", () => {
  const reference = createAgentReference("explorer", "session-1", { token: TOKEN });
  assert.equal(reference.kind, "agent");
  assert.equal(reference.path, "explorer");
  assert.equal(reference.name, "@explorer");
  assert.equal(reference.token, TOKEN);
  assert.ok(isAgentReference(reference));
  assert.ok(!isAgentReference(createFileReference("src/a.ts", "a.ts")));
});

test("a delegate has no file to expand into, whatever it is named", () => {
  // A `.txt` name would otherwise make the chip click-to-expand, and expanding
  // would delete the mention the user just made.
  assert.equal(isEditableTextReference(createAgentReference("notes.txt", "", { token: TOKEN })), false);
  assert.equal(
    isEditableTextReference({
      ...createAgentReference("explorer"),
      mimeType: "text/plain",
    }),
    false,
  );
  // The file behaviour is untouched.
  assert.equal(isEditableTextReference(createFileReference("a.txt", "a.txt")), true);
});

test("the chip is atomic, which is what makes deletion atomic", () => {
  // contentEditable=false is the whole mechanism: the caret cannot enter the
  // chip, so a delete takes the entire mention rather than a slice of its text.
  assert.match(editorSource, /chip\.contentEditable = "false"/);
  // Removal is by token — one character, so one character is what goes — and
  // the reference is dropped with it.
  assert.match(
    draftHookSource,
    /const next = source\.slice\(0, index\) \+ source\.slice\(index \+ 1\)/,
  );
  assert.match(
    draftHookSource,
    /current\.filter\(\(fileReference\) => fileReference\.token !== token\)/,
  );
});

test("an agent mention serializes back to the @token the rewrite resolves", () => {
  const reference = createAgentReference("explorer", "session-1", { token: TOKEN });
  // This is the whole contract with Electron main: the chip becomes `@explorer`,
  // which `findAgentMentions` resolves against the delegation catalog.
  const serialized = serializeInlineComposerFileReferences(
    `look${TOKEN}into this`,
    [reference],
  );
  assert.equal(serialized, "look @explorer into this");
  // A file still serializes to its own path, with no leading space: that is
  // long-standing output and the mention fix must not shift a byte of it.
  const file = createFileReference("src/a.ts", "a.ts", "session-1", { token: TOKEN });
  assert.equal(
    serializeInlineComposerFileReferences(`read${TOKEN}now`, [file]),
    "read@src/a.ts now",
  );
  // A mention at the start needs no leading space, and one already preceded by
  // whitespace gains nothing.
  const bare = createAgentReference("explorer", "s", { token: TOKEN });
  assert.equal(serializeInlineComposerFileReferences(`${TOKEN}go`, [bare]), "@explorer go");
  assert.equal(
    serializeInlineComposerFileReferences(`see ${TOKEN}go`, [bare]),
    "see @explorer go",
  );
});

test("a delegate never becomes an attachment", () => {
  // The optimistic transcript row is the first place a mention is mapped onto
  // an attachment. Its "path" is a handle, so a host read would be a miss.
  const message = optimisticUserMessage("row-1", "@explorer look", [
    createAgentReference("explorer", "s", { token: TOKEN }),
  ]);
  assert.equal(message.attachments, undefined);
  // Token-less agent references are dropped too — the guard is the kind, not
  // the sentinel that happens to be present today.
  assert.equal(
    optimisticUserMessage("row-2", "@explorer look", [
      { path: "explorer", name: "@explorer", kind: "agent" },
    ]).attachments,
    undefined,
  );
  // Files are unaffected.
  assert.equal(
    optimisticUserMessage("row-3", "read @a.ts", [
      createFileReference("a.ts", "a.ts"),
    ]).attachments?.length,
    1,
  );
  // And the prompt-side builder agrees, so main is never handed a handle to read.
  assert.match(storeSource, /if \(reference\.kind === "agent"\) return \[\];/);
});

test("a draft restore brings back a delegate, not a file chip", () => {
  const restored = restoreComposerReference(
    { path: "explorer", name: "@explorer", kind: "agent", description: "Sweeps the codebase.", token: TOKEN },
    "session-1",
  );
  assert.equal(restored.kind, "agent");
  assert.equal(restored.path, "explorer");
  assert.equal(restored.token, TOKEN);
  assert.equal(restored.description, "Sweeps the codebase.");
  // A file draft still restores as a file.
  const file = restoreComposerReference(
    { path: "src/a.ts", name: "a.ts", kind: "file", token: TOKEN },
    "session-1",
  );
  assert.equal(file.kind, "file");
  assert.equal(file.path, "src/a.ts");
});

test("accepting an agent splices a sentinel, like accepting a file", () => {
  // A token-less chip never paints now that chips are inline, so inserting
  // plain `@name` text would leave the mention looking like an unselected row.
  assert.match(composerSource, /createAgentReference\(/);
  assert.match(composerSource, /const token = nextChipToken\(\);/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * A streaming reply must not pay for Markdown it is about to replace.
 *
 * Each reveal commit re-renders whatever is inside `.prose-chat`, so rendering
 * the real tree means re-parsing it and repainting its syntax-colored spans on
 * every commit, growing with the reply. The text is shown raw while it arrives
 * and upgraded once it settles.
 */

const assistantTurnParts = await readFile(
  new URL("../src/features/chat/transcript/AssistantTurnParts.tsx", import.meta.url),
  "utf8",
);
const prose = await readFile(
  new URL("../src/styles/prose.css", import.meta.url),
  "utf8",
);

test("a streaming reply renders raw text instead of Markdown", () => {
  assert.match(
    assistantTurnParts,
    /\{streaming[\s\S]{0,400}\? <p className="assistant-streaming-text">/,
  );
  assert.match(assistantTurnParts, /: <Markdown source=\{displayContent\} \/>\}/);
  // No `streaming` prop survives on the rendered form: nothing renders there
  // while it is still growing, so the flag would only be dead configuration.
  assert.doesNotMatch(
    assistantTurnParts,
    /<Markdown source=\{displayContent\} streaming=/,
  );
});

test("the rendered form returns once the reply settles", () => {
  // The swap is driven by the same `streaming` flag that gates the reveal, so
  // completion and an error stop cannot leave the raw text on screen.
  assert.match(assistantTurnParts, /const showCursor = streaming && enabled/);
  assert.match(assistantTurnParts, /className=\{`message-bubble assistant-turn-fragment/);
});

test("raw streaming text keeps the Markdown source's newlines", () => {
  const block = prose.match(/\.assistant-streaming-text \{[^}]*\}/)?.[0] ?? "";
  assert.ok(block, "streaming text must have a rule");
  assert.match(block, /white-space:\s*pre-wrap/);
  // A long code line must still wrap rather than widen the bubble.
  assert.match(block, /overflow-wrap:\s*anywhere/);
  assert.match(block, /word-break:\s*break-word/);
});

test("the streaming cursor still lands on the raw text", () => {
  // The cursor uses `.prose-chat > :last-child` with a `*-excluded` list, so the
  // raw paragraph has to stay the last child inside `.prose-chat`.
  const endBlock = assistantTurnParts.slice(
    assistantTurnParts.indexOf("{displayContent ? ("),
    assistantTurnParts.indexOf("{message.error ?"),
  );
  assert.match(endBlock, /<div className="prose-chat">/);
  assert.match(endBlock, /<p className="assistant-streaming-text">/);
  assert.doesNotMatch(endBlock, /<\/p>[\s\S]*?<p /);
});

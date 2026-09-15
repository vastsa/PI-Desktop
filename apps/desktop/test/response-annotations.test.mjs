import { readStoreSource, readTranscriptSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ANNOTATION_BLOCK_CLOSE,
  ANNOTATION_BLOCK_HEADING,
  ANNOTATION_BLOCK_OPEN,
  ANNOTATION_INSTRUCTION,
  ANNOTATION_REQUEST_HEADING,
  MAX_ANNOTATION_CHARS,
  annotationExcerpt,
  annotationMarkerToken,
  requestTextWithoutAnnotations,
  responseAnnotation,
  responseAnnotationPrompt,
  splitAnnotationMarkerTokens,
} from "../src/lib/response-annotations.ts";

const store = await readStoreSource();
const transcript = await readTranscriptSource();
const markdown = await readFile(
  new URL("../src/components/Markdown.tsx", import.meta.url),
  "utf8",
);
const composer = await readFile(
  new URL("../src/components/ResponseAnnotationOverlay.tsx", import.meta.url),
  "utf8",
);
const overlay = await readFile(
  new URL("../src/components/SelectionQuoteButton.tsx", import.meta.url),
  "utf8",
);
const selectionQuote = await readFile(
  new URL("../src/lib/selection-quote.ts", import.meta.url),
  "utf8",
);
const styles = await readFile(
  new URL("../src/styles/messages.css", import.meta.url),
  "utf8",
);

const annotation = (overrides = {}) => ({
  id: "a1",
  messageId: "m1",
  text: "the quoted pass",
  annotation: "",
  createdAt: 0,
  ...overrides,
});

test("the prompt carries the annotation block the model reads", () => {
  const prompt = responseAnnotationPrompt("explain this", [
    annotation(),
    annotation({ id: "a2", messageId: "m2", text: "and this" }),
  ]);
  assert.equal(
    prompt,
    [
      ANNOTATION_BLOCK_HEADING,
      ANNOTATION_INSTRUCTION,
      ANNOTATION_BLOCK_OPEN,
      '[{"text":"the quoted pass","annotation":"","source":{"messageId":"m1"}},{"text":"and this","annotation":"","source":{"messageId":"m2"}}]',
      ANNOTATION_BLOCK_CLOSE,
      "",
      ANNOTATION_REQUEST_HEADING,
      "explain this",
    ].join("\n"),
  );
  // A session without annotations sends the draft untouched.
  assert.equal(responseAnnotationPrompt("explain this", []), "explain this");
});

test("a stored annotated prompt reduces back to the user's request", () => {
  const prompt = responseAnnotationPrompt("explain this", [annotation()]);
  assert.equal(requestTextWithoutAnnotations(prompt), "explain this");
  // A plain prompt is left alone, and a prompt that merely looks similar is not
  // truncated.
  assert.equal(requestTextWithoutAnnotations("explain this"), "explain this");
  assert.equal(
    requestTextWithoutAnnotations(`## My request:\nplain`),
    `## My request:\nplain`,
  );
});

test("an excerpt is capped without cutting a surrogate pair", () => {
  assert.equal(annotationExcerpt("  keep me  "), "keep me");
  assert.equal(annotationExcerpt("a\r\nb"), "a\nb");
  const capped = annotationExcerpt("x".repeat(MAX_ANNOTATION_CHARS + 5));
  assert.equal(capped.length, MAX_ANNOTATION_CHARS + 1);
  assert.ok(capped.endsWith("…"));
  const surrogate = annotationExcerpt(`${"a".repeat(MAX_ANNOTATION_CHARS - 1)}😀tail`);
  assert.doesNotMatch(surrogate, /[\uD800-\uDBFF]$/);
});

test("a new annotation keeps its excerpt and starts without a comment", () => {
  const created = responseAnnotation({
    id: "a9",
    messageId: "m7",
    text: "  a pass  ",
    createdAt: 5,
  });
  assert.deepEqual(created, {
    id: "a9",
    messageId: "m7",
    text: "a pass",
    annotation: "",
    createdAt: 5,
  });
});

test("a marker token round-trips through the split the renderer uses", () => {
  const source = `before${annotationMarkerToken(2)}after`;
  assert.deepEqual(splitAnnotationMarkerTokens(source), [
    { kind: "text", value: "before" },
    { kind: "marker", index: 2 },
    { kind: "text", value: "after" },
  ]);
  // Text without tokens stays one segment, so the pipeline can skip the work.
  assert.deepEqual(splitAnnotationMarkerTokens("plain"), [
    { kind: "text", value: "plain" },
  ]);
});

test("the markdown pass turns marker tokens into numbered references", () => {
  assert.match(markdown, /remarkAnnotationMarkers/);
  assert.match(markdown, /const staticRemarkPlugins = \[remarkGfm, remarkMath, remarkAnnotationMarkers\]/);
  assert.match(markdown, /url: annotationMarkerHref\(segment\.index\)/);
  assert.match(markdown, /if \(annotationIndex !== null\) \{\s*return <AnnotationMarker index=\{annotationIndex\} \/>;\s*\}/);
  // Without a whitelisted scheme the sanitizer drops the href and the raw
  // directive would render as link text.
  assert.match(markdown, /href: \[\.\.\.\(defaultSchema\.protocols\?\.href \?\? \[\]\), ANNOTATION_MARKER_SCHEME\.replace\(\/:\$\/, ""\)\]/);
  // The reference renders a numbered reference with the excerpt (and comment)
  // as its tooltip.
  assert.match(markdown, /\[index - 1\]/);
  assert.match(markdown, /t\("chat\.annotationSelectedText"\)/);
  assert.match(markdown, /t\("chat\.annotationComment"\)/);
  assert.match(markdown, /t\("chat\.annotationMarker", \{ index \}\)/);
  assert.match(markdown, /className="response-annotation-marker"/);
  assert.match(markdown, /aria-label=\{t\("chat\.annotationMarker"/);
});

test("the answer body is never decorated with markers of our own", () => {
  // The reference marks an annotation only where the model cites it: the
  // transcript renders the answer source as it arrived.
  assert.match(transcript, /<Markdown source=\{part\.message\.content\} \/>/);
  assert.doesNotMatch(transcript, /sourceWithMarkers|annotationMarkers\(/);
  assert.doesNotMatch(transcript, /sourceWithAnnotationMarkers/);
});

test("a marker never joins a quote, a copy, or a selection", () => {
  assert.match(selectionQuote, /"\.response-annotation-marker",/);
  assert.match(styles, /\.response-annotation-marker \{[\s\S]*?user-select: none/);
  assert.match(styles, /\.response-annotation-marker:hover,[\s\S]*?text-decoration: underline dashed/);
});

test("annotations attach to assistant turns, not to the draft", () => {
  // The row has to say what it is before a selection can be routed.
  assert.match(transcript, /data-row-role="assistant"/);
  assert.match(transcript, /data-row-role=\{isSessionMessage \? undefined : "user"\}/);
  // Attaching goes through the comment editor state the store owns (D-LOCAL-response-annotations).
  assert.match(
    store,
    /openResponseAnnotationEditor: \(\{ messageId, text, annotationId, anchor \}\) => \{/,
  );
  assert.match(store, /annotationEditorFor\(current, \{/);
});

test("sending carries the annotations and consumes them", () => {
  assert.match(store, /const outgoing = responseAnnotationPrompt\(content, annotations\);/);
  assert.match(store, /content: outgoing,/);
  assert.match(store, /isDefaultSessionTitle\(current\?\.title\)[\s\S]*?promptFallbackSessionTitle\(\s*content,/);
  assert.match(store, /consumeAnnotations\(\)/);
  // Queued prompts are sends too.
  assert.match(store, /await get\(\)\.enqueuePrompt\(outgoing, draft, sessionId\);/);
});

test("the floating annotation index exposes count, locate, edit and clear", () => {
  assert.match(composer, /data-testid="annotation-float"/);
  assert.match(composer, /t\("chat\.annotationChip", \{ count: annotations\.length \}\)/);
  assert.match(composer, /onClick=\{clear\}/);
  assert.match(composer, /onNavigate\(annotation\)/);
});

test("the overlay annotates a response and quotes anything else", () => {
  assert.match(overlay, /if \(target\.annotatable\) \{/);
  assert.match(
    overlay,
    /openResponseAnnotationEditor\(\{\s*messageId: target\.rowAnchorId,\s*text: target\.markdown,\s*anchor: selectionAnnotationAnchorWithinRow\(target\.rowAnchorId\),\s*\}\);/,
  );
  assert.match(overlay, /quoteMessageIntoComposer\(\{ title, text: target\.markdown \}\)/);
});
